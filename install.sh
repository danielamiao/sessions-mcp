#!/usr/bin/env bash
# One command installs the whole sessions experience into Claude Code:
#   1. the MCP server (search / share / pull / unshare)
#   2. a SessionStart hook — makes Claude AWARE of the capability and offer to share at natural
#      stopping points, plus a first-few-sessions one-line hint so the user learns it exists
#   3. slash commands (/share-session, /find-session) — a discoverable handle in the `/` menu
# Idempotent: safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$HERE/dist/sessions-mcp.mjs"
[ -f "$BUNDLE" ] || { echo "bundle missing at $BUNDLE"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code CLI ('claude') not found on PATH"; exit 1; }

# 1. MCP server — USER scope so it's available in EVERY project, not just this repo. (Default
#    `claude mcp add` scope is `local` = current project only, which "disappears" when you cd away.)
#    Remove any prior local-scoped registration first so re-running upgrades cleanly.
claude mcp remove sessions >/dev/null 2>&1 || true
claude mcp add --scope user sessions -- node "$BUNDLE"

# 2. SessionStart hook (awareness + proactive offer + decaying first-run hint)
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
node - "$SETTINGS" "$BUNDLE" <<'NODE'
const fs = require("fs");
const [settingsPath, bundle] = process.argv.slice(2);
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
settings.hooks ??= {};
// SessionStart: discoverability context + a background capture sync (catches sessions that ended).
settings.hooks.SessionStart ??= [];
if (!JSON.stringify(settings.hooks.SessionStart).includes("--session-start-hook")) {
  settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: `node ${bundle} --session-start-hook` }] });
}
// SessionEnd: capture the session that just finished.
settings.hooks.SessionEnd ??= [];
if (!JSON.stringify(settings.hooks.SessionEnd).includes("--sync")) {
  settings.hooks.SessionEnd.push({ hooks: [{ type: "command", command: `node ${bundle} --sync` }] });
}
// Stop (fires each turn): periodic capture of LONG-RUNNING sessions you never end. The upload is
// time-debounced client-side (a session re-uploads at most every ~10 min), so this stays cheap.
settings.hooks.Stop ??= [];
if (!JSON.stringify(settings.hooks.Stop).includes("--sync")) {
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: `node ${bundle} --sync` }] });
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log("✓ hooks wired: automatic capture (SessionStart + SessionEnd + periodic Stop) + discoverability");
NODE

# 3. Slash commands (discoverable in the `/` menu)
CMDS="$HOME/.claude/commands"
mkdir -p "$CMDS"
cat > "$CMDS/share-session.md" <<'MD'
Share the current agent session as a link the team can open.

Call the `share_session` tool (from the "sessions" MCP server) on the current session, then give me
the link. Remind me that anyone with the link can view AND pull the full session into their own
agent, and that I can revoke it later with unshare_session.
MD
cat > "$CMDS/find-session.md" <<'MD'
Search my past agent sessions.

Use the `search_my_sessions` tool (from the "sessions" MCP server) with my query below and show me
the best matches — what I asked and what each session accomplished — so I can reuse earlier work.

Query: $ARGUMENTS
MD
echo "✓ added /share-session and /find-session slash commands"

# 4. mo (Momento's own harness), if installed. mo reads Claude-compatible SessionStart hooks from
#    ~/.claude/settings.json, so the capture hook wired above already fires on `mo` launch (and the
#    client now parses ~/.mo/sessions). This step additionally registers the sessions MCP server in
#    ~/.mo/config.toml so search/share/pull tools work INSIDE `mo agent`. mo gates MCP behind
#    `mcp_enabled` (off by default), so we also flip that on in the user's personal config.
if command -v mo >/dev/null 2>&1; then
  MO_CONFIG="$HOME/.mo/config.toml"
  mkdir -p "$HOME/.mo"
  node - "$MO_CONFIG" "$BUNDLE" <<'NODE'
const fs = require("fs");
const [configPath, bundle] = process.argv.slice(2);
let text = "";
try { text = fs.readFileSync(configPath, "utf8"); } catch {}
if (text.includes('name = "sessions"')) {
  console.log("✓ mo: sessions MCP server already registered");
  process.exit(0);
}
// mcp_enabled is a TOP-LEVEL key — it must precede any [table], so insert it before the first table
// header rather than appending at EOF (which would nest it under the last table).
if (!/^\s*mcp_enabled\s*=/m.test(text)) {
  const firstTable = text.search(/^\s*\[/m);
  const line = "mcp_enabled = true\n";
  text = firstTable === -1 ? line + text : text.slice(0, firstTable) + line + text.slice(firstTable);
}
// A new [[mcp.servers]] header opens its own table scope, so appending at EOF is always well-formed.
const block =
  `\n[[mcp.servers]]\nname = "sessions"\ncommand = "node"\nargs = [${JSON.stringify(bundle)}]\n`;
fs.writeFileSync(configPath, (text.endsWith("\n") || text === "" ? text : text + "\n") + block);
console.log("✓ mo: registered the sessions MCP server + enabled MCP in ~/.mo/config.toml");
NODE
fi

echo
echo "✓ sessions installed. Start a NEW Claude Code (or mo) session. Your agent will offer to share your"
echo "  work at natural stopping points; or use  /share-session  ·  /find-session <topic>  ·  or just ask."
echo "  Capture is automatic and cross-harness: Claude Code, Codex, and mo sessions all sync."
