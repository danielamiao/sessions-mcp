// Startup runtime check.
//
// Every network call goes through global `fetch`, which node gained in 18. On an older node the
// client still starts, still reads sessions, and still reports "captured 0 new/changed session(s)"
// — while every upload throws `ReferenceError: fetch is not defined` into a per-session catch. Under
// a hook nobody reads stderr, so capture appears healthy and stores nothing, indefinitely.
//
// install.sh checks the version too, but it can't help here: the hooks invoke whatever `node`
// resolves to at hook time, which is not necessarily the node that ran the installer. Switching a
// version manager's default to 16 silently breaks capture months later. This is the check that
// still fires in that case.

/** Node version that first shipped global `fetch`. */
const MIN_NODE_MAJOR = 18;

/** Why this runtime can't run the client, or `null` if it can. Takes the globals as arguments so the
 *  decision is testable without a second node install — pass `globalThis.fetch` and
 *  `process.version` at the call site. */
export function unsupportedRuntimeMessage(fetchImpl: unknown, nodeVersion: string): string | null {
  if (typeof fetchImpl === "function") return null;
  return [
    `sessions-mcp: needs node ${MIN_NODE_MAJOR}+ (running ${nodeVersion}) — global fetch is missing,`,
    "  so nothing can be uploaded, searched, or shared. Refusing to run rather than silently",
    "  capturing nothing. Install node 18+ (nvm: `nvm install --lts`) and start a new session.",
  ].join("\n");
}

/** Exit non-zero with a diagnostic when the runtime can't support the client. Non-zero matters: a
 *  hook that exits 0 after printing a success line is indistinguishable from a working install. */
export function assertSupportedRuntime(): void {
  const message = unsupportedRuntimeMessage(globalThis.fetch, process.version);
  if (message === null) return;
  console.error(message);
  process.exit(1);
}
