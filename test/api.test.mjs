// Sidecar-path derivation. The token, sync state, and hint counter all live beside the config file;
// deriving the siblings from the config DIRECTORY (not a regex on the basename) is what keeps a
// custom SESSIONS_MCP_CONFIG from making writeSyncState overwrite the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeSyncState, readSyncState, bumpHintCount } from "../dist/api.js";

test("sync state + hint counter never overwrite a non-'config.json' token file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-mcp-api-"));
  // A config path that does NOT end in config.json — the case the old basename regex mishandled.
  const configFile = path.join(dir, "token.json");
  fs.writeFileSync(configFile, JSON.stringify({ token: "keep-me" }));
  const prev = process.env.SESSIONS_MCP_CONFIG;
  process.env.SESSIONS_MCP_CONFIG = configFile;
  try {
    writeSyncState({ s1: { mtime: 1, at: 2 } });
    bumpHintCount();
    // The token file is untouched — sync state / hint counter landed in siblings, not on it.
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).token, "keep-me");
    assert.deepEqual(readSyncState(), { s1: { mtime: 1, at: 2 } });
    assert.ok(fs.existsSync(path.join(dir, "sync.json")), "sync.json is a sibling of the config");
    assert.ok(fs.existsSync(path.join(dir, "hint-count")), "hint-count is a sibling of the config");
  } finally {
    if (prev === undefined) delete process.env.SESSIONS_MCP_CONFIG;
    else process.env.SESSIONS_MCP_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
