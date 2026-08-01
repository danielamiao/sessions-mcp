// Parser tests over committed fixtures — the harness log formats are unofficial surfaces, so these
// pin exactly what we extract and, as importantly, what we exclude (subagent + meta lines).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeSession, parseCodexSession, parseMoSession } from "../dist/logs.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("claude parser extracts user/assistant text, skips sidechain+meta+garbage", () => {
  const session = parseClaudeSession(path.join(here, "fixtures", "claude-session.jsonl"));
  assert.ok(session);
  assert.equal(session.harness, "claude-code");
  assert.equal(session.turns.length, 3);
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.title, "Fix the flaky auth test");
  // A `/clear` slash command (logged as <command-name> wrapper XML) is meta, not the title.
  assert.ok(!JSON.stringify(session.turns).includes("command-name"), "slash-command wrapper excluded");
  assert.equal(session.turns[0].text, "Fix the flaky auth test", "first turn is real prose, not /clear");
  assert.ok(session.turns[1].text.includes("[tool: Bash]"), "tool_use surfaces as a marker");
  assert.ok(!JSON.stringify(session.turns).includes("subagent line"), "sidechain excluded");
  assert.ok(!JSON.stringify(session.turns).includes("meta line"), "meta excluded");
  assert.equal(session.started_at_ms, Date.parse("2026-07-30T10:00:00.000Z"));
});

test("codex parser reads real user/assistant turns, skips developer + injected preamble", () => {
  const session = parseCodexSession(path.join(here, "fixtures", "codex-session.jsonl"));
  assert.ok(session);
  assert.equal(session.harness, "codex");
  assert.equal(session.turns.length, 2, "developer + AGENTS.md preamble excluded");
  assert.equal(session.turns[0].text, "Refactor the parser");
  assert.equal(session.title, "Refactor the parser", "title is the real prompt, not injected context");
  assert.equal(session.turns[1].role, "assistant");
  assert.ok(!JSON.stringify(session.turns).includes("permissions"), "developer role excluded");
  assert.ok(!JSON.stringify(session.turns).includes("AGENTS.md"), "injected context excluded");
});

test("mo parser reads user/assistant turns, adds tool markers, skips meta + tool_result", () => {
  const session = parseMoSession(path.join(here, "fixtures", "mo-session.jsonl"));
  assert.ok(session);
  assert.equal(session.harness, "mo");
  assert.equal(session.turns.length, 3, "user + 2 assistant; session_meta/tool_result/model_switch excluded");
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.turns[0].text, "add retry with backoff to the client");
  assert.equal(session.title, "add retry with backoff to the client");
  assert.ok(session.turns[1].text.includes("[tool: edit_file]"), "tool call surfaces as a marker");
  assert.ok(!JSON.stringify(session.turns).includes("file edited"), "tool_result excluded");
  assert.equal(session.started_at_ms, 1785522432058, "started_at from the session_meta header");
});

test("empty or unreadable file yields null, not a throw", () => {
  assert.equal(parseClaudeSession("/nonexistent/file.jsonl"), null);
  assert.equal(parseMoSession("/nonexistent/file.jsonl"), null);
});

// A real 52 MB log parses to a sub-MB upload (it's ~98% tool output, stripped to markers), so the
// read is never the bottleneck; this pins that a large, many-line log is read whole and correctly —
// every turn captured, multibyte intact, and a final line with no trailing newline included.
test("reads a large many-line log correctly (all turns, multibyte, no trailing newline)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-mcp-big-"));
  const file = path.join(dir, "big.jsonl");
  try {
    const N = 4000;
    const lines = [];
    for (let i = 0; i < N; i += 1) {
      const role = i % 2 === 0 ? "user" : "assistant";
      lines.push(
        JSON.stringify({
          type: role,
          timestamp: "2026-07-30T10:00:00.000Z",
          message: { role, content: `turn ${i} café ${"x".repeat(50)}` },
        }),
      );
    }
    fs.writeFileSync(file, lines.join("\n")); // no trailing newline

    const session = parseClaudeSession(file);
    assert.ok(session, "a large session is captured, not skipped");
    assert.equal(session.turns.length, N, "every line became a turn");
    assert.ok(session.turns[0].text.includes("café"), "multibyte survives (start)");
    assert.ok(session.turns[N - 1].text.includes("turn 3999"), "the final line (no trailing \\n) is captured");
    assert.ok(session.turns[N - 1].text.includes("café"), "multibyte survives (last line)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
