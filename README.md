# sessions-mcp

Search, share, and pull your AI coding-agent sessions — **Claude Code** and **Codex** — from inside
the agent itself. A small MCP server: no account, no signup, one-command install.

- **Share** the current session as a link. Anyone with the link can view it *and* pull the full
  session into their own agent to build on it.
- **Automatic capture:** every session is uploaded + summarized on its own — you never have to remember to save. Sharing stays explicit.
- **Search** your past sessions by meaning ("how did I fix that flaky auth thing") — not just keywords.
- **Pull** a shared session into your current one to continue where someone left off.

## Install (one command)

You keep using Claude Code / Codex exactly as-is.

**Needs:** `node` ≥ 18, `bash`, `curl`, and at least one of Claude Code / Codex / mo. macOS and Linux.
(macOS's stock bash 3.2 is fine. On Alpine, `apk add bash curl` first — neither ships by default.)

```bash
curl -fsSL https://raw.githubusercontent.com/danielamiao/sessions-mcp/main/install.sh | bash
```

Or from a checkout, which installs the bundle you just built instead of downloading one:

```bash
./install.sh
```

Either way the server lands at `~/.sessions-mcp/sessions-mcp.mjs` and the config points there, so
you can delete the checkout afterwards. Re-running is safe, and switches an existing install to the
current path rather than leaving a stale one behind.

The installer wires whichever harnesses it finds — it doesn't require any particular one:

| | what it does |
|---|---|
| **Claude Code** | registers the MCP server at user scope, wires the capture hooks, adds `/share-session` + `/find-session` |
| **mo** | registers the server in `~/.mo/config.toml` and enables MCP; capture hooks come from the Claude-compatible settings file |
| **Codex** | prints the `~/.codex/config.toml` block to paste — Codex has no CLI to register a server, and its config is hand-edited |

Start a **new** agent session afterward.

> Piping a script into `bash` means running whatever that URL serves today. This one has no CI and
> the bundle it fetches is a hand-built artifact committed to the repo, so nothing signs or
> reproduces it — read [`install.sh`](install.sh) first if that matters to you, or clone and use the
> checkout path.

Then just ask your agent: *"share this session"* or *"find my session about X."*

## What it does with your data

This talks to a small hosted backend. When you **share** a session, its full transcript becomes
readable and pullable by **anyone with the link** — treat a share link like a public paste. Captured
sessions are private to your (anonymous) token until you share them, secrets are scrubbed before
storage, and hosted copies expire after ~30 days. This is a personal project shared as-is (see the
LICENSE) with no warranty — don't put anything you couldn't paste into a public gist.

Point it at a different backend with `SESSIONS_MCP_URL` if you run your own.

## Build from source

```bash
npm install && npm run build && npm run bundle   # produces dist/sessions-mcp.mjs
npm test
```
