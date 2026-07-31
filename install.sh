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

# 1. MCP server
claude mcp add sessions -- node "$BUNDLE"

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

echo
echo "✓ sessions installed. Start a NEW Claude Code session. Claude will offer to share your work at"
echo "  natural stopping points; or use  /share-session  ·  /find-session <topic>  ·  or just ask."
