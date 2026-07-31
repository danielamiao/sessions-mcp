// The background-watcher singleton lock: one live watcher at a time, with stale-lock takeover so a
// crashed watcher can't wedge capture forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimWatchLock, touchWatchLock, clearWatchLock } from "../dist/api.js";

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-lock-"));
  const prev = process.env.SESSIONS_MCP_CONFIG;
  process.env.SESSIONS_MCP_CONFIG = path.join(dir, "config.json");
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SESSIONS_MCP_CONFIG;
    else process.env.SESSIONS_MCP_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("first claim wins; a second concurrent claim is refused", () => {
  withTempConfig(() => {
    assert.equal(claimWatchLock(60_000), true, "first watcher claims the lock");
    assert.equal(claimWatchLock(60_000), false, "a second watcher is refused while the first is live");
    clearWatchLock();
    assert.equal(claimWatchLock(60_000), true, "after release, a new watcher can claim");
    clearWatchLock();
  });
});

test("a stale lock (heartbeat older than staleMs) is stolen", () => {
  withTempConfig(() => {
    assert.equal(claimWatchLock(60_000), true);
    // With staleMs = 0, the just-written heartbeat is already 'stale', so the next claim steals it.
    assert.equal(claimWatchLock(0), true, "stale lock is taken over, not deadlocked");
    // touch keeps it fresh, so a normal-window claim is again refused.
    touchWatchLock();
    assert.equal(claimWatchLock(60_000), false);
    clearWatchLock();
  });
});
