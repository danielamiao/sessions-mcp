# sessions-mcp

Search, share, and pull your AI coding-agent sessions — **Claude Code** and **Codex** — from inside
the agent itself. A small MCP server: no account, no signup, one-command install.

- **Share** the current session as a link. Anyone with the link can view it *and* pull the full
  session into their own agent to build on it.
- **Automatic capture:** every session is uploaded + summarized on its own — you never have to remember to save. Sharing stays explicit.
- **Search** your past sessions by meaning ("how did I fix that flaky auth thing") — not just keywords.
- **Pull** a shared session into your current one to continue where someone left off.

## Install (one command)

You keep using Claude Code / Codex exactly as-is. From a checkout of this repo:

```bash
./install.sh
```

That registers the MCP server and (for Claude Code) a hook so the agent offers to share your work at
natural stopping points, plus `/share-session` and `/find-session` slash commands. Start a **new**
agent session afterward.

Codex: add to `~/.codex/config.toml`:

```toml
[mcp_servers.sessions]
command = "node"
args = ["/absolute/path/to/this/repo/dist/sessions-mcp.mjs"]
```

Then just ask your agent: *"share this session"* or *"find my session about X."*

## What it does with your data

This talks to a small hosted backend. When you **share** a session, its full transcript becomes
readable and pullable by **anyone with the link** — treat a share link like a public paste. Captured
sessions are private to your (anonymous) token until you share them, and hosted copies expire after
~30 days. Obvious key shapes (`sk-ant-…`, `sk-…`, `gwk_live_…`, `AKIA…`, `Bearer …`) are scrubbed on
your machine before upload, and again server-side — but pattern-matching only catches what it
recognises, so it is a backstop, not a guarantee. This is a personal project shared as-is (see the
LICENSE) with no warranty — don't put anything you couldn't paste into a public gist.

Point it at a different backend with `SESSIONS_MCP_URL` if you run your own.

## Build from source

```bash
npm install && npm run build && npm run bundle   # produces dist/sessions-mcp.mjs
npm test
```
