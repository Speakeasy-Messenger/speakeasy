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

/**
 * Pull the handle out of an inbound deep-link URL. Returns undefined
 * for URLs we don't own (different scheme, different host) and for
 * malformed handles — caller should ignore those rather than feed
 * garbage into NewChat.
 */
export function parseAdd(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${HANDLE_LINK_SCHEME}:`) return undefined;
  // URL parses `speakeasy://add?handle=foo` with hostname='add', so
  // both `host` and `pathname` reads work. Use hostname for clarity.
  if (parsed.hostname !== HANDLE_LINK_HOST) return undefined;
  const handle = parsed.searchParams.get('handle');
  if (!handle) return undefined;
  // Delegate to the shared validator — accepts both the new HANDLE_REGEX
  // and the legacy 3-word ID_REGEX. Single source of truth so future
  // regex tweaks propagate without a re-edit here.
  if (!isUserId(handle)) return undefined;
  return handle;
}
