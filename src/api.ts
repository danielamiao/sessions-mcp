// The sessions API client: anonymous-token bootstrap + the five server calls. The token is minted
// on first use (zero signup) and stored in a config file the user owns; losing it orphans the
// hosted copies (30-day TTL bounds the loss) — signup/claim comes later, not in the POC.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LocalSession } from "./logs.js";

/** Where the minted token lives (env-overridable for tests). */
export function configPath(): string {
  return (
    process.env.SESSIONS_MCP_CONFIG ??
    path.join(os.homedir(), ".config", "sessions-mcp", "config.json")
  );
}

/** Default gateway the sessions API lives behind, baked so a user never has to find or paste a URL.
 *  Overridable with SESSIONS_MCP_URL (a different cell, local testing). */
const DEFAULT_SESSIONS_URL = "https://ozfxbgvg5mep7hw2psvuw7wnqq0imidg.lambda-url.us-west-2.on.aws";

/** The API base URL — the baked default unless SESSIONS_MCP_URL overrides it. */
export function baseUrl(): string {
  return (process.env.SESSIONS_MCP_URL ?? DEFAULT_SESSIONS_URL).replace(/\/$/, "");
}

interface StoredConfig {
  token: string;
  principal_id?: string;
}

function readConfig(): StoredConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

/** The sessions token, minting one on first use. */
export async function token(): Promise<string> {
  const existing = readConfig();
  if (existing?.token) return existing.token;
  const response = await fetch(`${baseUrl()}/sessions/anon`, { method: "POST" });
  if (!response.ok) throw new Error(`mint failed: ${response.status} ${await response.text()}`);
  const minted = (await response.json()) as { token: string; principal_id: string };
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(minted, null, 2), { mode: 0o600 });
  return minted.token;
}

async function post(pathname: string, body: unknown): Promise<any> {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gw-key": await token() },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function upload(session: LocalSession): Promise<void> {
  const { mtime_ms: _mtime, ...body } = session;
  await post("/sessions/upload", body);
}

export async function search(query: string): Promise<any[]> {
  const result = await post("/sessions/search", { query });
  return result.sessions ?? [];
}

export async function share(session_id: string): Promise<{ link: string; token: string }> {
  return post("/sessions/share", { session_id });
}

export async function unshare(session_id: string): Promise<void> {
  await post("/sessions/unshare", { session_id });
}

/** Pull a shared session by link or bare 64-hex token — public read, no auth needed. `full` forces
 *  the whole transcript; otherwise the server returns the digest, auto-expanding to full for a short
 *  session. */
export async function pull(linkOrToken: string, full = false): Promise<any> {
  const match = linkOrToken.match(/[0-9a-f]{64}/);
  if (!match) throw new Error("that doesn't look like a session share link or token");
  const url = `${baseUrl()}/sessions/pull/${match[0]}${full ? "?full=1" : ""}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`pull: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---- lazy sync state ------------------------------------------------------

/** Per-session last-uploaded mtimes, kept beside the token. */
function syncStatePath(): string {
  return configPath().replace(/config\.json$/, "sync.json");
}

type SyncEntry = number | { mtime: number; at: number };
export function readSyncState(): Record<string, SyncEntry> {
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeSyncState(state: Record<string, SyncEntry>): void {
  fs.mkdirSync(path.dirname(syncStatePath()), { recursive: true });
  fs.writeFileSync(syncStatePath(), JSON.stringify(state));
}

// ---- background-watcher singleton lock -----------------------------------

/** Lock file guarding the single live capture watcher (beside the token). */
function watchLockPath(): string {
  return configPath().replace(/config\.json$/, "watch.lock");
}

/** Try to become the singleton capture watcher. Returns true iff we now hold the lock. The lock
 *  carries a heartbeat the holder refreshes each poll (see {@link touchWatchLock}); a lock whose
 *  heartbeat is older than `staleMs` belonged to a crashed watcher and is stolen. This keeps exactly
 *  one watcher alive even though every session start spawns one. */
export function claimWatchLock(staleMs: number): boolean {
  const file = watchLockPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Atomic create-if-absent: only one racing watcher wins the fresh claim.
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid }), { flag: "wx" });
      return true;
    } catch {
      let at = 0;
      try {
        at = JSON.parse(fs.readFileSync(file, "utf8")).at ?? 0;
      } catch {
        /* unreadable/corrupt lock — treat as stale below */
      }
      if (Date.now() - at < staleMs) return false; // a live watcher holds it
      try {
        fs.unlinkSync(file); // stale → drop it and retry the atomic claim
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Refresh the watcher lock's heartbeat — called each poll so a live watcher keeps its claim. */
export function touchWatchLock(): void {
  try {
    fs.writeFileSync(watchLockPath(), JSON.stringify({ at: Date.now(), pid: process.pid }));
  } catch {
    /* best-effort */
  }
}

/** Release the watcher lock on exit. */
export function clearWatchLock(): void {
  try {
    fs.unlinkSync(watchLockPath());
  } catch {
    /* already gone */
  }
}

/** Increment and return the SessionStart hint counter (beside the token). Used to show the
 *  first-run "you can share/search sessions" nudge a few times, then go quiet. */
export function bumpHintCount(): number {
  const file = configPath().replace(/config\.json$/, "hint-count");
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
  } catch {}
  n += 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(n));
  } catch {}
  return n;
}
