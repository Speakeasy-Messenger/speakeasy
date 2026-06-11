/**
 * Deep-link encoding for sharing a Speakeasy handle as a QR code or
 * shareable URL.
 *
 * The canonical shareable form is now an **https Universal Link / App
 * Link**: `https://speakeasyapp.xyz/add?handle=<handle>`. When the app is
 * installed (and the App Link is verified via the domain's
 * assetlinks.json / apple-app-site-association), the OS opens the app
 * straight to the add-contact flow; when it isn't, the same URL opens the
 * web fallback page (`/add`) that offers the store download — so a shared
 * link converts a non-user instead of dead-ending. The legacy custom
 * scheme `speakeasy://add?handle=<handle>` is still produced/accepted for
 * backward-compat (old QR codes, and the web page's app-open attempt).
 *
 * Both ends (QR/share producer + the App.tsx Linking handler consumer)
 * go through this file so the format stays in lockstep.
 */

import { isUserId } from '@speakeasy/shared';

export const HANDLE_LINK_SCHEME = 'speakeasy';
export const HANDLE_LINK_HOST = 'add';
export const HANDLE_LINK_WEB_HOST = 'speakeasyapp.xyz';
export const HANDLE_LINK_WEB_PATH = '/add';

const SCHEME_PREFIX = `${HANDLE_LINK_SCHEME}://${HANDLE_LINK_HOST}`; // speakeasy://add
const WEB_PREFIX = `https://${HANDLE_LINK_WEB_HOST}${HANDLE_LINK_WEB_PATH}`; // https://speakeasyapp.xyz/add

function clean(handle: string): string {
  // Strip a leading `@` if a caller passes the displayed form.
  return handle.replace(/^@/, '').toLowerCase();
}

/**
 * Canonical shareable link — the https Universal/App Link. Use this for
 * the QR code and the native share sheet.
 */
export function encodeAdd(handle: string): string {
  return `${WEB_PREFIX}?handle=${encodeURIComponent(clean(handle))}`;
}

/** The raw custom-scheme link (legacy / direct app-open). */
export function encodeAddScheme(handle: string): string {
  return `${SCHEME_PREFIX}?handle=${encodeURIComponent(clean(handle))}`;
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
 * Pull the handle out of an inbound deep-link URL — accepts BOTH the
 * `speakeasy://add?handle=` custom scheme and the
 * `https://speakeasyapp.xyz/add?handle=` Universal/App Link. Returns
 * undefined for URLs we don't own (different scheme/host) and for
 * malformed handles — caller should ignore those rather than feed garbage
 * into NewChat.
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
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  // Scheme + host are case-insensitive per RFC 3986; compare lowercased.
  let rest: string;
  if (lower.startsWith(SCHEME_PREFIX.toLowerCase())) {
    rest = trimmed.slice(SCHEME_PREFIX.length);
  } else if (lower.startsWith(WEB_PREFIX.toLowerCase())) {
    rest = trimmed.slice(WEB_PREFIX.length);
  } else {
    return undefined;
  }
  // The char after the host/path must delimit it — `?` (query) or `/`
  // (trailing slash). Rejects same-prefix hosts/paths like
  // `speakeasy://address?...` or `https://speakeasyapp.xyz/address?...`.
  if (rest.length === 0 || (rest[0] !== '?' && rest[0] !== '/')) return undefined;
  const q = rest.indexOf('?');
  if (q === -1) return undefined;
  const handle = queryParam(rest.slice(q + 1), 'handle');
  if (!handle) return undefined;
  // Delegate to the shared validator — accepts both the new HANDLE_REGEX
  // and the legacy 3-word ID_REGEX. Single source of truth.
  if (!isUserId(handle)) return undefined;
  return handle;
}
