#!/usr/bin/env node
// The sessions MCP server (stdio): capture/search/share/pull over agent sessions, backed by the
// Momento gateway sessions API. Capture is lazy — each tool call first syncs local session logs
// (Claude Code + Codex) that changed since the last upload, so nothing runs in the background and
// nothing is captured while the tools are unused.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { localSessions } from "./logs.js";
import * as api from "./api.js";

// Discoverability hook: `node sessions-mcp.mjs --session-start-hook` emits a SessionStart
// additionalContext block that makes Claude AWARE of the sessions capability and PROACTIVE about
// offering it at natural moments — the fix for "the user doesn't know this MCP tool exists." MCP
// tools have no UI, so without this the capability is invisible until the user happens to ask.
// Wired (opt-in) by install.sh into the user's Claude Code settings.
if (process.argv.includes("--session-start-hook")) {
  let context =
    "The user has the 'sessions' MCP tools installed. You can share the CURRENT session as a " +
    "public link (share_session) — anyone with the link can view the session AND pull its full " +
    "transcript into their own agent, so it unfurls in Slack and a teammate can build on it — or " +
    "search their PAST agent " +
    "sessions to reuse earlier work (search_my_sessions). When the user reaches a decision, " +
    "finishes a task, or lands on a useful conclusion, briefly offer to make it shareable (e.g. " +
    "“want a link to share this?”) — a one-line offer, not a nag. Only mint a link when " +
    "the user says yes. When the user asks how they solved something before, or seems to be " +
    "redoing past work, use search_my_sessions.";
  // Decaying one-time hint: for the first few sessions, also have Claude tell the user the
  // capability exists (once), then go quiet so it never nags. Counter lives beside the token.
  const shown = api.bumpHintCount();
  if (shown <= 3) {
    context +=
      " ALSO, at the very start of THIS session only, tell the user in one short line that they " +
      "can ask you to share this session as a link or search their past sessions (so they learn " +
      "the capability exists).";
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }),
  );
  process.exit(0);
}

/** Project a raw index row to the fields worth showing an agent: the ask, the result, and the
 *  facts — dropping the internal keys (pk/sk/s3_key) and the redundant title. Keeps a result
 *  compact and readable rather than dumping raw DynamoDB rows. */
function presentSession(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: row.session_id,
    harness: row.harness,
    turns: row.turns,
    started_at_ms: row.started_at_ms,
    asked: row.excerpt, // the opening request
    summary: row.summary, // what the session did — the LLM summary (the useful part)
  };
  if (row.why) out.why = row.why; // semantic-search relevance reason, when present
  return out;
}

/** Sync changed local sessions up to the corpus; returns how many uploaded. Fail-soft per session. */
async function syncLocalSessions(): Promise<number> {
  const state = api.readSyncState();
  let uploaded = 0;
  for (const session of localSessions()) {
    if ((state[session.session_id] ?? 0) >= session.mtime_ms) continue;
    try {
      await api.upload(session);
      state[session.session_id] = session.mtime_ms;
      uploaded += 1;
    } catch (error) {
      console.error(`sessions-mcp: upload ${session.session_id} failed: ${error}`);
    }
  }
  api.writeSyncState(state);
  return uploaded;
}

const server = new McpServer({ name: "sessions", version: "0.0.1" });

server.tool(
  "list_recent_sessions",
  "List the user's recent agent sessions (Claude Code, Codex) from their private session corpus. " +
    "Syncs local session logs first, so the list is current.",
  {},
  async () => {
    const uploaded = await syncLocalSessions();
    const sessions = await api.search("");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { synced_now: uploaded, sessions: sessions.slice(0, 25).map(presentSession) },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "search_my_sessions",
  "Semantic search over the user's own agent sessions — matches by MEANING, not just keywords (a " +
    "query about 'retries' finds a session about 'exponential backoff'), ranked by relevance with a " +
    "one-line `why` per hit. Each result shows what was asked and a summary of what the session did. " +
    "Private: only the user's own sessions are reachable.",
  {
    query: z
      .string()
      .describe("what to find — a topic, error, or how something was solved (e.g. 'how did I fix the 401')"),
  },
  async ({ query }) => {
    await syncLocalSessions();
    const sessions = await api.search(query);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sessions: sessions.slice(0, 25).map(presentSession) }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "share_session",
  "Mint a public share link for ONE of the user's sessions. Anyone with the link can view it AND " +
    "pull the full session content into their own agent (it is not just a read-only view) — so this " +
    "shares the whole transcript. ONLY call this when the " +
    "user has explicitly asked to share a session (e.g. 'share this with…', 'give me a link'). " +
    "Never call it proactively; offering is fine, minting requires their yes. The link is " +
    "revocable via unshare_session.",
  { session_id: z.string().describe("the session_id to share (from list/search results)") },
  async ({ session_id }) => {
    await syncLocalSessions();
    const result = await api.share(session_id);
    return {
      content: [
        {
          type: "text",
          text:
            `Share link — anyone with it can view AND pull the full session into their own agent: ${result.link}\n` +
            "Paste it in Slack — it unfurls with the session title and summary. " +
            "Revoke any time with unshare_session.",
        },
      ],
    };
  },
);

server.tool(
  "unshare_session",
  "Revoke a session's share link — the link stops working immediately.",
  { session_id: z.string().describe("the session_id to unshare") },
  async ({ session_id }) => {
    await api.unshare(session_id);
    return { content: [{ type: "text", text: `Unshared ${session_id}; the link is dead.` }] };
  },
);

server.tool(
  "pull_session",
  "Pull a shared agent session (by share link or token) into the current conversation to continue " +
    "or build on it. A SHORT session comes back as the full transcript automatically. A LONGER " +
    "session comes back as a summary + its most recent turns (full=false); when that happens you " +
    "MUST ask the user whether they want the full transcript before proceeding — do not silently " +
    "continue on just the summary. If they say yes, call pull_session again with full=true.",
  {
    link: z.string().describe("a session share link (https://…/s/<token>) or the bare 64-hex token"),
    full: z
      .boolean()
      .optional()
      .describe("pull the entire transcript (use after the user confirms they want the full session)"),
  },
  async ({ link, full }) => {
    const digest = await api.pull(link, full === true);
    const turns = (digest.full ? digest.turns : digest.recent_turns) ?? [];
    const rendered = turns
      .map((turn: { role: string; text: string }) => `[${turn.role}]\n${turn.text}`)
      .join("\n\n");
    if (digest.full) {
      return {
        content: [
          {
            type: "text",
            text:
              `Pulled the FULL session "${digest.title}" (${digest.harness}, ${digest.total_turns} turns).\n\n` +
              `Summary:\n${digest.summary ?? "(none)"}\n\nTranscript:\n${rendered}`,
          },
        ],
      };
    }
    // Long session → return the digest AND tell the model to confront the user with the choice.
    return {
      content: [
        {
          type: "text",
          text:
            `Pulled a DIGEST of "${digest.title}" (${digest.harness}) — this is a longer session ` +
            `(${digest.total_turns} turns), so you got the summary + the last ${turns.length} turns.\n\n` +
            `Summary:\n${digest.summary ?? "(none)"}\n\nRecent turns:\n${rendered}\n\n` +
            `ACTION: before continuing, ask the user whether this summary is enough or they want the ` +
            `full ${digest.total_turns}-turn transcript. If they want it, call pull_session again with full=true.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
