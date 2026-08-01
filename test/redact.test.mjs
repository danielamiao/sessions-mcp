// Secret-scrub tests. The cases mirror the gateway's own `redact_secrets` tests (vend-ingress
// `sessions/upload.rs`) so a drift between the two scrubbers shows up as a failure here rather than
// as a secret that only one of them catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../dist/redact.js";
import { localSessions } from "../dist/logs.js";

test("redacts the key shapes we ship", () => {
  assert.equal(redactSecrets("key sk-ant-api03-AAAAbbbbCCCC here"), "key [redacted] here");
  assert.equal(redactSecrets("use sk-proj-abcdefghijkl now"), "use [redacted] now");
  assert.equal(redactSecrets("gwk_live_abcdefgh1234"), "[redacted]");
  assert.equal(redactSecrets("AKIAIOSFODNN7EXAMPLE"), "[redacted]");
  assert.equal(redactSecrets("Authorization: Bearer eyJhbGci.payload.sig"), "Authorization: Bearer [redacted]");
});

test("leaves ordinary prose alone", () => {
  // Short runs are words, not keys.
  assert.equal(redactSecrets("the sk-1 flag"), "the sk-1 flag");
  // `sk-` and `AKIA` only fire on a word boundary, so they can't eat the middle of an identifier.
  assert.equal(redactSecrets("brisk-lookingthing"), "brisk-lookingthing");
  assert.equal(redactSecrets("MAKAKIAsomethinglong"), "MAKAKIAsomethinglong");
  assert.equal(redactSecrets("Bearer x"), "Bearer x");
  assert.equal(redactSecrets("no secrets in this line at all"), "no secrets in this line at all");
});

// Verbatim inputs from the gateway's own tests (`redacts_provider_and_gateway_keys_but_not_prose`,
// `redacts_bearer_values_and_akia_ids`). If these two ever disagree across the wire, one side is
// letting through what the other catches.
test("parity with the gateway scrubber on its own test inputs", () => {
  const keys = redactSecrets("use sk-ant-api03-AbCdEf123456 and gwk_live_deadbeefdeadbeef to auth; risk-free");
  assert.ok(!keys.includes("AbCdEf123456"), keys);
  assert.ok(!keys.includes("deadbeefdeadbeef"), keys);
  assert.ok(keys.includes("risk-free"), `prose hyphens must survive: ${keys}`);

  const bearer = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x AKIAIOSFODNN7EXAMPLE");
  assert.ok(!bearer.includes("eyJhbGciOiJIUzI1NiJ9"), bearer);
  assert.ok(!bearer.includes("AKIAIOSFODNN7EXAMPLE"), bearer);
  assert.ok(bearer.includes("Bearer [redacted]"), bearer);
});

test("bearer redaction is case-insensitive, like the gateway", () => {
  // The gateway matches `bearer` ignoring ASCII case; the client must too, or a lowercase marker
  // leaves the machine and is caught only server-side — the exact drift this port exists to prevent.
  for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
    const out = redactSecrets(`token is ${scheme} eyJhbGciOiJIUzI1deadbeefcafe here`);
    assert.ok(!out.includes("eyJhbGciOiJIUzI1deadbeefcafe"), `${scheme}: ${out}`);
    assert.ok(out.includes("[redacted]"), `${scheme}: ${out}`);
  }
});

test("redacts every occurrence, not just the first", () => {
  const scrubbed = redactSecrets("a sk-ant-aaaaaaaaaa b sk-ant-bbbbbbbbbb c");
  assert.equal(scrubbed, "a [redacted] b [redacted] c");
});

test("a non-matching marker does not stall the scan", () => {
  // `sk-` mid-word is skipped; the scan must resume AFTER it so a later real key is still caught.
  assert.equal(redactSecrets("brisk-x then sk-proj-abcdefghij"), "brisk-x then [redacted]");
});

test("localSessions scrubs before anything can upload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-mcp-redact-"));
  const project = path.join(root, "claude", "-Users-someone-repo");
  fs.mkdirSync(project, { recursive: true });
  const line = (role, text) =>
    JSON.stringify({ type: role, timestamp: "2026-07-30T10:00:00.000Z", message: { role, content: text } });
  fs.writeFileSync(
    path.join(project, "session-with-secret.jsonl"),
    [
      line("user", "deploy with sk-ant-api03-SUPERSECRETVALUE please"),
      line("assistant", "exporting AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"),
    ].join("\n"),
  );

  process.env.SESSIONS_MCP_CLAUDE_DIR = path.join(root, "claude");
  process.env.SESSIONS_MCP_CODEX_DIR = path.join(root, "absent-codex");
  process.env.SESSIONS_MCP_MO_DIR = path.join(root, "absent-mo");

  const sessions = localSessions();
  assert.equal(sessions.length, 1, "fixture session was read (else the assertions below are vacuous)");
  const serialized = JSON.stringify(sessions[0]);
  assert.ok(serialized.includes("[redacted]"), "the scrub actually ran");
  assert.ok(!serialized.includes("SUPERSECRETVALUE"), "anthropic key never reaches the upload shape");
  assert.ok(!serialized.includes("AKIAIOSFODNN7EXAMPLE"), "aws key id never reaches the upload shape");
  assert.ok(!sessions[0].title.includes("SUPERSECRETVALUE"), "title is scrubbed too");
  assert.ok(sessions[0].turns[0].text.includes("deploy with"), "surrounding prose survives");
});
