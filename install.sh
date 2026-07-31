#!/usr/bin/env bash
# One command installs the whole sessions experience into Claude Code:
#   1. the MCP server (search / share / pull / unshare)
#   2. a SessionStart hook — makes Claude AWARE of the capability and offer to share at natural
#      stopping points, plus a first-few-sessions one-line hint so the user learns it exists
#   3. slash commands (/share-session, /find-session) — a discoverable handle in the `/` menu
#
# Runs two ways, and lands in the same place either way:
#   curl -fsSL https://raw.githubusercontent.com/danielamiao/sessions-mcp/main/install.sh | bash
#   ./install.sh          # from a checkout — uses the bundle you just built
#
# The bundle is always INSTALLED to a stable path ($HOME/.sessions-mcp) rather than referenced where
# it was found, because the hooks and MCP registrations below bake an absolute path into config
# files. Pointing those at a checkout means moving or deleting the checkout silently breaks capture
# long after the fact — and gives the piped install nothing to point at.
# Idempotent: safe to re-run, and re-running repoints an existing install at the current path.
set -euo pipefail

RAW_URL="${SESSIONS_MCP_RAW_URL:-https://raw.githubusercontent.com/danielamiao/sessions-mcp/main}"
PREFIX="${SESSIONS_MCP_HOME:-$HOME/.sessions-mcp}"
BUNDLE="$PREFIX/sessions-mcp.mjs"

command -v node >/dev/null || { echo "node not found on PATH (the server runs on node)"; exit 1; }
command -v claude >/dev/null || { echo "Claude Code CLI ('claude') not found on PATH"; exit 1; }

# Checkout mode only when $0 really names this script on disk. Piped, $0 is "bash", so this is false
# and we download — deliberately, so `curl | bash` run from inside a stale checkout installs the
# current bundle rather than whatever happens to be sitting in the cwd.
LOCAL_BUNDLE=""
case "${0:-}" in
  */install.sh | install.sh)
    if [ -f "$0" ]; then
      HERE="$(cd "$(dirname "$0")" && pwd)"
      [ -f "$HERE/dist/sessions-mcp.mjs" ] && LOCAL_BUNDLE="$HERE/dist/sessions-mcp.mjs"
    fi
    ;;
esac

mkdir -p "$PREFIX"
if [ -n "$LOCAL_BUNDLE" ]; then
  cp "$LOCAL_BUNDLE" "$BUNDLE"
  echo "✓ installed the local bundle to $BUNDLE"
else
  command -v curl >/dev/null || { echo "curl not found on PATH"; exit 1; }
  # Download beside the target (same filesystem, so the install is an atomic rename) and keep the
  # .mjs suffix — `node --check` picks module vs script from the extension, and the bundle is ESM.
  DOWNLOAD="$PREFIX/.sessions-mcp.download.mjs"
  curl -fsSL "$RAW_URL/dist/sessions-mcp.mjs" -o "$DOWNLOAD"
  # Whatever arrives gets executed by the hooks below, so refuse anything that isn't JavaScript —
  # a captive-portal login page returning 200 is the case this catches. (`curl -f` already fails an
  # HTTP error, and a short read trips its own partial-transfer check.) Parsing is not authenticity:
  # see the install note in README.md.
  if ! node --check "$DOWNLOAD" >/dev/null 2>&1; then
    rm -f "$DOWNLOAD"
    echo "downloaded file isn't valid JavaScript — aborting rather than installing it"; exit 1
  fi
  mv "$DOWNLOAD" "$BUNDLE"
  echo "✓ downloaded the bundle to $BUNDLE"
fi

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
// Reconcile to the CURRENT bundle path rather than adding only when absent: an add-if-missing guard
// leaves an earlier install's path in place, so switching install methods (or moving the checkout)
// leaves hooks invoking a file that may no longer exist. Drop every entry that names this tool,
// then add today's.
const wire = (event, flag) => {
  const existing = settings.hooks[event] ?? [];
  settings.hooks[event] = existing.filter((entry) => !JSON.stringify(entry).includes("sessions-mcp"));
  settings.hooks[event].push({ hooks: [{ type: "command", command: `node ${bundle} ${flag}` }] });
};
// SessionStart: discoverability context + a background capture sync (catches sessions that ended).
wire("SessionStart", "--session-start-hook");
// SessionEnd: capture the session that just finished.
wire("SessionEnd", "--sync");
// Stop (fires each turn): periodic capture of LONG-RUNNING sessions you never end. The upload is
// time-debounced client-side (a session re-uploads at most every ~10 min), so this stays cheap.
wire("Stop", "--sync");
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
// mcp_enabled is a TOP-LEVEL key — it must precede any [table], so insert it before the first table
// header rather than appending at EOF (which would nest it under the last table).
if (!/^\s*mcp_enabled\s*=/m.test(text)) {
  const firstTable = text.search(/^\s*\[/m);
  const line = "mcp_enabled = true\n";
  text = firstTable === -1 ? line + text : text.slice(0, firstTable) + line + text.slice(firstTable);
}
// Rewrite our own server block when it's already there, for the same reason the hooks are
// reconciled rather than added-if-missing: returning early would leave a previous install's bundle
// path. Split on the array-of-tables header so only OUR block is touched — other servers pass
// through untouched, and keys we don't own (a hand-added env/cwd) survive.
const header = "[[mcp.servers]]";
const parts = text.split(/^[ \t]*\[\[mcp\.servers\]\][ \t]*$/m);
const ours = parts.findIndex((part, index) => 0 < index && /^[ \t]*name[ \t]*=[ \t]*"sessions"[ \t]*$/m.test(part));
if (ours === -1) {
  const block = `${header}\nname = "sessions"\ncommand = "node"\nargs = [${JSON.stringify(bundle)}]\n`;
  text = (text.endsWith("\n") || text === "" ? text : text + "\n") + "\n" + block;
  console.log("✓ mo: registered the sessions MCP server + enabled MCP in ~/.mo/config.toml");
} else {
  parts[ours] = parts[ours].replace(/^[ \t]*args[ \t]*=[ \t]*\[[^\]]*\][ \t]*$/m, `args = [${JSON.stringify(bundle)}]`);
  // Join with the bare header: the split consumed the header LINE but not its newline, which each
  // part still carries. Adding one here would insert a blank line per run, growing the file every
  // time this idempotent installer is re-run.
  text = parts.join(header);
  console.log("✓ mo: updated the sessions MCP server path in ~/.mo/config.toml");
}
fs.writeFileSync(configPath, text);
NODE
fi

echo
echo "✓ sessions installed. Start a NEW Claude Code (or mo) session. Your agent will offer to share your"
echo "  work at natural stopping points; or use  /share-session  ·  /find-session <topic>  ·  or just ask."
echo "  Capture is automatic and cross-harness: Claude Code, Codex, and mo sessions all sync."
