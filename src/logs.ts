// Local session-log readers: Claude Code (~/.claude/projects/**/*.jsonl) and Codex
// (~/.codex/sessions/**/*.jsonl). Both parse to one neutral shape — the upload contract of the
// sessions API. Parsers fail soft per line (the formats are unofficial surfaces): an unparsable
// line is skipped, never fatal, so a harness format drift degrades capture rather than breaking
// every tool call.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return null;
  }
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
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return null;
  }
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

/** All parseable local sessions, both harnesses, newest first, capped at `limit` files per root. */
export function localSessions(limit = 50): LocalSession[] {
  const sessions: LocalSession[] = [];
  for (const file of jsonlFilesUnder(claudeProjectsDir()).slice(0, limit)) {
    const parsed = parseClaudeSession(file);
    if (parsed) sessions.push(parsed);
  }
  for (const file of jsonlFilesUnder(codexSessionsDir()).slice(0, limit)) {
    const parsed = parseCodexSession(file);
    if (parsed) sessions.push(parsed);
  }
  return sessions.sort((a, b) => b.started_at_ms - a.started_at_ms);
}
