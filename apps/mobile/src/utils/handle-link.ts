/**
 * Deep-link encoding for sharing a Speakeasy handle as a QR code or
 * shareable URL. Format: `speakeasy://add?handle=<handle>` — kept
 * deliberately short so the QR is dense and easy to scan from a phone
 * screen at conversational distance.
 *
 * Both ends (QR generator + Linking handler) consume from this file
 * so the format stays consistent.
 *
 * Why a custom URI scheme rather than https:// universal-links: we
 * don't have a verified web domain yet. When `speakeasyapp.xyz`
 * exists with `assetlinks.json`, this can be upgraded — encodeAdd
 * is the only producer + parseAdd is the only consumer, both kept in
 * lockstep.
 */

import { isUserId } from '@speakeasy/shared';

export const HANDLE_LINK_SCHEME = 'speakeasy';
export const HANDLE_LINK_HOST = 'add';

export function encodeAdd(handle: string): string {
  // Strip a leading `@` if a caller passes the displayed form.
  const clean = handle.replace(/^@/, '').toLowerCase();
  return `${HANDLE_LINK_SCHEME}://${HANDLE_LINK_HOST}?handle=${encodeURIComponent(clean)}`;
}

/** Read one query-string parameter without `URLSearchParams`. */
function queryParam(query: string, key: string): string | undefined {
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    if (k !== key) continue;
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Pull the handle out of an inbound deep-link URL. Returns undefined
 * for URLs we don't own (different scheme, different host) and for
 * malformed handles — caller should ignore those rather than feed
 * garbage into NewChat.
 *
 * Parsed by hand rather than via `new URL()`. Hermes does not implement
 * `URL.searchParams`, so `new URL('speakeasy://add?handle=foo')` — which
 * works under Node in vitest — throws or returns an empty host/params in
 * the actual app. That made the QR deep link silently no-op and drop the
 * user on the chat list (reported rc.40). String parsing keeps prod
 * (Hermes) and tests (Node) on one code path, the same reason
 * `packages/shared/ids` avoids `node:crypto`.
 */
export function parseAdd(url: string): string | undefined {
  const prefix = `${HANDLE_LINK_SCHEME}://${HANDLE_LINK_HOST}`; // speakeasy://add
  const trimmed = url.trim();
  // Scheme + host are case-insensitive per RFC 3986; compare lowercased.
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return undefined;
  }
  const rest = trimmed.slice(prefix.length);
  // The char after the host must delimit it — `?` (query) or `/` (path).
  // Rejects same-prefix hosts like `speakeasy://address?handle=foo`.
  if (rest.length === 0 || (rest[0] !== '?' && rest[0] !== '/')) return undefined;
  const q = rest.indexOf('?');
  if (q === -1) return undefined;
  const handle = queryParam(rest.slice(q + 1), 'handle');
  if (!handle) return undefined;
  // Delegate to the shared validator — accepts both the new HANDLE_REGEX
  // and the legacy 3-word ID_REGEX. Single source of truth so future
  // regex tweaks propagate without a re-edit here.
  if (!isUserId(handle)) return undefined;
  return handle;
}
