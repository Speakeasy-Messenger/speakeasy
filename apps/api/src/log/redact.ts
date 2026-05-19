/**
 * Redaction helpers for structured logs.
 *
 * Device tokens, push tokens, admin tokens and TURN credentials are all
 * bearer-like secrets: whoever can replay one can impersonate the device
 * or call the privileged endpoint. They must never reach a log sink in
 * full — log aggregators are searchable, retained, and frequently shared
 * more widely than the database.
 *
 * `redactToken` keeps only a short tail: enough to correlate two log
 * lines as referring to the same token, useless for replay on its own.
 */

/** Plaintext tail length kept for cross-line correlation. */
const TAIL = 6;

/**
 * Redact a bearer-like token for logging. Returns a short, non-reversible
 * preview — `…<tail> (len N)` — or `<none>` when the token is absent.
 * Tokens at or below the tail length are not previewed at all.
 */
export function redactToken(token: string | undefined | null): string {
  if (!token) return '<none>';
  if (token.length <= TAIL) return `<redacted> (len ${token.length})`;
  return `…${token.slice(-TAIL)} (len ${token.length})`;
}
