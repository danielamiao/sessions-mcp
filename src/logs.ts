// Local session-log readers: Claude Code (~/.claude/projects/**/*.jsonl) and Codex
// (~/.codex/sessions/**/*.jsonl). Both parse to one neutral shape — the upload contract of the
// sessions API. Parsers fail soft per line (the formats are unofficial surfaces): an unparsable
// line is skipped, never fatal, so a harness format drift degrades capture rather than breaking
// every tool call.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { redactSecrets } from "./redact.js";

/** One neutral transcript turn (the API's upload contract). */
export interface Turn {
  role: string;
  text: string;
}

/** One parsed local session, ready to upload. */
export interface LocalSession {
  session_id: string;
  harness: string;
  started_at_ms: number;
  title: string;
  turns: Turn[];
  /** Source file mtime (ms) — the lazy-sync change detector. */
  mtime_ms: number;
}

/** Claude Code's projects root (env-overridable so tests never touch the real home dir). */
export function claudeProjectsDir(): string {
  return process.env.SESSIONS_MCP_CLAUDE_DIR ?? path.join(os.homedir(), ".claude", "projects");
}

/** Codex's sessions root (same override discipline). */
export function codexSessionsDir(): string {
  return process.env.SESSIONS_MCP_CODEX_DIR ?? path.join(os.homedir(), ".codex", "sessions");
}

/** mo's sessions root — `~/.mo/sessions/<id>.jsonl`, with an optional `<id>.name` title sidecar. */
export function moSessionsDir(): string {
  return process.env.SESSIONS_MCP_MO_DIR ?? path.join(os.homedir(), ".mo", "sessions");
}

/** Largest session log we'll read into memory. A harness log is an untrusted producer (a crafted or
 *  legitimately enormous session can be gigabytes); `readFileSync` would load it all at once and
 *  `.split("\n")` would materialize every line, exhausting the process. Over this, the file is
 *  skipped rather than read — losing that one session's capture, never the whole server. */
const MAX_LOG_BYTES = 25 * 1024 * 1024;

/** Read a session log's text, or `null` when it's missing, unreadable, or larger than
 *  [`MAX_LOG_BYTES`] — the size is checked with `stat` BEFORE the file is read into memory. */
function readCappedLog(file: string): string | null {
  try {
    if (MAX_LOG_BYTES < fs.statSync(file).size) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every *.jsonl under `root` (one directory level of project folders, then files), newest first. */
function jsonlFilesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root, 0);
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);
}

/** Claude Code logs a slash command (and its output) as a pseudo user/assistant turn wrapped in
 *  these tags — `/clear`, `/compact`, custom commands, their stdout/stderr. They're harness control,
 *  not conversation: skipped so a `/clear` never becomes the session title or pollutes the
 *  transcript/search, the same way the Codex parser skips its preamble markers. */
const CLAUDE_META_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
];

function isClaudeMeta(text: string): boolean {
  return CLAUDE_META_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Extract visible text from a Claude Code message content (string or block array). */
function claudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "tool_use") return `[tool: ${block.name ?? "?"}]`;
      if (block?.type === "tool_result") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Parse one Claude Code session log; null when it holds no usable turns. */
export function parseClaudeSession(file: string): LocalSession | null {
  const turns: Turn[] = [];
  let startedAt = 0;
  const content = readCappedLog(file);
  if (content === null) return null;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // fail soft: unofficial format
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isSidechain || entry.isMeta) continue; // subagent + meta lines stay out of the transcript
    const text = claudeText(entry.message?.content).trim();
    if (!text || isClaudeMeta(text)) continue;
    if (!startedAt && entry.timestamp) startedAt = Date.parse(entry.timestamp) || 0;
    turns.push({ role: entry.message?.role === "user" ? "user" : "assistant", text });
  }
  if (turns.length === 0) return null;
  const firstUser = turns.find((turn) => turn.role === "user");
  return {
    session_id: path.basename(file, ".jsonl"),
    harness: "claude-code",
    started_at_ms: startedAt || Math.floor(fs.statSync(file).mtimeMs),
    title: (firstUser?.text ?? "Agent session").slice(0, 120),
    turns,
    mtime_ms: fs.statSync(file).mtimeMs,
  };
}

/** Codex injects these as `user`/`developer` messages ahead of the real turn — the harness's own
 *  context, not the conversation. Skipped by prefix, the same way the Claude parser skips the
 *  local-command caveat. Validated against a real Codex 0.146 rollout log. */
const CODEX_PREAMBLE_MARKERS = [
  "<permissions instructions>",
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
];

function isCodexPreamble(text: string): boolean {
  return CODEX_PREAMBLE_MARKERS.some((marker) => text.startsWith(marker));
}

/** Parse one Codex rollout log. Validated against a real Codex 0.146 `rollout-*.jsonl`. */
export function parseCodexSession(file: string): LocalSession | null {
  const turns: Turn[] = [];
  let startedAt = 0;
  const content = readCappedLog(file);
  if (content === null) return null;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex rollout lines wrap the item under `payload`: {type:"response_item", payload:{type:
    // "message", role, content:[{type:"input_text"|"output_text", text}]}}. Only real user/assistant
    // turns are transcript content — the `developer`/`system` roles carry the harness's own
    // permissions + tool preamble, not the conversation.
    const item = entry.payload ?? entry;
    if (item?.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = (Array.isArray(item.content) ? item.content : [])
      .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text || isCodexPreamble(text)) continue;
    if (!startedAt && entry.timestamp) startedAt = Date.parse(entry.timestamp) || 0;
    turns.push({ role: item.role, text });
  }
  if (turns.length === 0) return null;
  const firstUser = turns.find((turn) => turn.role === "user");
  return {
    session_id: path.basename(file, ".jsonl").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80),
    harness: "codex",
    started_at_ms: startedAt || Math.floor(fs.statSync(file).mtimeMs),
    title: (firstUser?.text ?? "Agent session").slice(0, 120),
    turns,
    mtime_ms: fs.statSync(file).mtimeMs,
  };
}

/** Assemble the visible text of a mo `assistant_turn`: its content plus a `[tool: name]` marker per
 *  tool call, so the transcript shows what the agent did (parity with the Claude parser's markers). */
function moAssistantText(entry: any): string {
  const parts: string[] = [];
  if (typeof entry.content === "string" && entry.content.trim()) parts.push(entry.content.trim());
  for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
    if (call?.name) parts.push(`[tool: ${call.name}]`);
  }
  return parts.join("\n");
}

/** The user-chosen name from the `<id>.name` sidecar beside a mo transcript, if present. */
function readMoName(transcriptFile: string): string | undefined {
  try {
    const name = fs.readFileSync(transcriptFile.replace(/\.jsonl$/, ".name"), "utf8").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Parse one mo session transcript (`~/.mo/sessions/<id>.jsonl`). Each line is a self-describing
 *  event `{schema_version, recorded_at_ms, type, …}`; we keep `user` and `assistant_turn` as turns
 *  and skip the rest (session_meta header, tool_result, model_switch, compaction summary). Null when
 *  it holds no usable turns. */
export function parseMoSession(file: string): LocalSession | null {
  const turns: Turn[] = [];
  let startedAt = 0;
  const content = readCappedLog(file);
  if (content === null) return null;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // fail soft: append-only log, a torn final line is normal
    }
    if (!startedAt && typeof entry.recorded_at_ms === "number") startedAt = entry.recorded_at_ms;
    if (entry.type === "user") {
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (text) turns.push({ role: "user", text });
    } else if (entry.type === "assistant_turn") {
      const text = moAssistantText(entry);
      if (text) turns.push({ role: "assistant", text });
    }
    // session_meta / tool_result / model_switch / summary / other: not transcript turns.
  }
  if (turns.length === 0) return null;
  const firstUser = turns.find((turn) => turn.role === "user");
  return {
    session_id: path.basename(file, ".jsonl"),
    harness: "mo",
    started_at_ms: startedAt || Math.floor(fs.statSync(file).mtimeMs),
    title: (readMoName(file) ?? firstUser?.text ?? "Agent session").slice(0, 120),
    turns,
    mtime_ms: fs.statSync(file).mtimeMs,
  };
}

/** Scrub secret-shaped text out of a parsed session. Every session reaches the upload through
 *  `localSessions`, so scrubbing here covers all three parsers — and a fourth harness gets it
 *  without anyone remembering to ask. */
function scrubbed(session: LocalSession): LocalSession {
  return {
    ...session,
    title: redactSecrets(session.title),
    turns: session.turns.map((turn) => ({ ...turn, text: redactSecrets(turn.text) })),
  };
}

/** All parseable local sessions across harnesses, newest first, capped at `limit` files per root.
 *  Secrets are scrubbed here, before any caller can upload one. */
export function localSessions(limit = 50): LocalSession[] {
  const sessions: LocalSession[] = [];
  for (const file of jsonlFilesUnder(claudeProjectsDir()).slice(0, limit)) {
    const parsed = parseClaudeSession(file);
    if (parsed) sessions.push(scrubbed(parsed));
  }
  for (const file of jsonlFilesUnder(codexSessionsDir()).slice(0, limit)) {
    const parsed = parseCodexSession(file);
    if (parsed) sessions.push(scrubbed(parsed));
  }
  for (const file of jsonlFilesUnder(moSessionsDir()).slice(0, limit)) {
    const parsed = parseMoSession(file);
    if (parsed) sessions.push(scrubbed(parsed));
  }
  return sessions.sort((a, b) => b.started_at_ms - a.started_at_ms);
}
