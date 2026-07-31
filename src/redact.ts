// Client-side secret scrub, applied to every session before it leaves the machine.
//
// The server scrubs too, and that pass stays the authoritative one — a client can be old, patched,
// or lying. This layer exists because the capture is AUTOMATIC: the Stop hook uploads a growing
// session roughly every ten minutes, so a turn that happened to contain a key is in flight before
// anyone decides to share anything. Scrubbing here keeps it on the machine rather than relying on
// the server to drop it after receipt.
//
// Deliberately a port of the gateway's `redact_secrets` (vend-ingress `sessions/upload.rs`) rather
// than a second, cleverer matcher: two scrubbers that disagree are worse than one, because the
// difference is invisible until a secret lands in the gap. Keep them in step.

/** Chars that can continue a secret value after its marker. */
const SECRET_RUN = /[A-Za-z0-9_-]/;
/** Bearer values also admit dots (JWTs). */
const BEARER_RUN = /[A-Za-z0-9._-]/;
/** Shortest run worth treating as a secret — below this it's prose, not a key. */
const MIN_RUN = 8;

/** Marker prefixes and whether the marker must sit on a word boundary. Order matters: the more
 *  specific `sk-ant-` runs before the generic `sk-`, so an Anthropic key is consumed once. */
const NEEDLES: ReadonlyArray<readonly [string, boolean]> = [
  ["sk-ant-", false],
  ["sk-", true],
  ["gwk_live_", false],
  ["AKIA", true],
];

/** Length of the run of `pattern` chars at the start of `text`. */
function runLength(text: string, pattern: RegExp): number {
  let n = 0;
  while (n < text.length && pattern.test(text[n])) n += 1;
  return n;
}

/** Replace the plausible-secret run following each occurrence of `needle` with `[redacted]`. With
 *  `boundaryOnly`, a marker mid-word is left alone (so `sk-` doesn't eat a hyphenated word and
 *  `AKIA` doesn't fire inside an identifier). */
function redactAfter(text: string, needle: string, boundaryOnly: boolean): string {
  let out = "";
  let rest = text;
  for (;;) {
    const found = rest.indexOf(needle);
    if (found === -1) break;
    const before = rest.slice(0, found);
    const tail = rest.slice(found + needle.length);
    const previous = before.at(-1);
    const atBoundary = previous === undefined || !/[A-Za-z0-9]/.test(previous);
    const run = runLength(tail, SECRET_RUN);
    out += before;
    if ((!boundaryOnly || atBoundary) && run >= MIN_RUN) {
      out += "[redacted]";
      rest = tail.slice(run);
    } else {
      // Emit the marker and resume AFTER it, never at it — resuming at the marker would rescan the
      // same position forever.
      out += needle;
      rest = tail;
    }
  }
  return out + rest;
}

/** Redact the token after each `Bearer ` marker, keeping the scheme so the shape stays readable. */
function redactBearer(text: string): string {
  const marker = "Bearer ";
  let out = "";
  let rest = text;
  for (;;) {
    const found = rest.indexOf(marker);
    if (found === -1) break;
    const head = rest.slice(0, found + marker.length);
    const tail = rest.slice(found + marker.length);
    const run = runLength(tail, BEARER_RUN);
    out += head;
    if (run >= MIN_RUN) {
      out += "[redacted]";
      rest = tail.slice(run);
    } else {
      rest = tail;
    }
  }
  return out + rest;
}

/** Scrub obvious secret shapes from one piece of transcript text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [needle, boundaryOnly] of NEEDLES) out = redactAfter(out, needle, boundaryOnly);
  return redactBearer(out);
}
