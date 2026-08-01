// Startup runtime guard. The failure it prevents is silent — an old node captures nothing while
// printing a success line — so these pin that the check is driven by fetch's presence and that the
// message stays actionable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unsupportedRuntimeMessage } from "../dist/runtime.js";

test("a runtime with fetch is accepted", () => {
  assert.equal(unsupportedRuntimeMessage(() => {}, "v20.9.0"), null);
  // The real one, whatever this test is running on — node 18+ per package.json engines.
  assert.equal(unsupportedRuntimeMessage(globalThis.fetch, process.version), null);
});

test("a runtime without fetch is rejected, and says what to do", () => {
  const message = unsupportedRuntimeMessage(undefined, "v16.20.2");
  assert.ok(message, "node 16 must be rejected");
  assert.ok(message.includes("v16.20.2"), "names the version actually running");
  assert.ok(message.includes("18"), "names the version needed");
  // The whole point is not silently capturing nothing, so the message must say so.
  assert.match(message, /fetch/i);
});

test("a non-callable fetch is rejected too", () => {
  // A polyfill that assigned a non-function would otherwise pass a truthiness check.
  for (const bogus of [undefined, null, 0, "", "fetch", {}]) {
    assert.ok(unsupportedRuntimeMessage(bogus, "v16.0.0"), `rejects ${JSON.stringify(bogus)}`);
  }
});
