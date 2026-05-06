import { factory } from 'ulid';

/**
 * Mobile-safe ID validators + non-wordlist generators. This module is
 * deliberately Node-free: no `node:crypto`, no `node:fs`, no wordlist
 * imports — Metro bundles it cleanly into the React Native app.
 *
 * `ulid`'s default export uses `detectPrng()`, which inspects the
 * runtime once and returns a closure. In Hermes that probe finds a
 * `crypto` global (RN provides a stub) and returns a closure that calls
 * `crypto.getRandomValues` — but every invocation throws "undefined is
 * not a function" because the stub doesn't implement the method.
 * `detectPrng(true)` doesn't help: the insecure fallback only fires when
 * the *probe* fails, not when the closure does.
 *
 * Sidestep entirely with `Math.random`. These IDs are identifiers
 * (message/group/community), not secrets — randomness quality doesn't
 * matter, only uniqueness.
 *
 * Wordlist-dependent generation (`generateUserId`, `ID_SPACE_SIZE`)
 * lives in `./generate.ts` (server-only subpath); the server imports
 * via `@speakeasy/shared/ids/generate`.
 */
const ulid = factory(() => Math.random());

/**
 * Legacy 3-word user id, retained because conversation ids and any
 * pre-handle-cutover state still validate against it. New enrollment
 * (`POST /v1/enroll`) requires the strict `HANDLE_REGEX` instead.
 */
export const ID_REGEX = /^[a-z]+-[a-z]+-[a-z]+$/;

/**
 * User-chosen handle: lowercase ASCII, must start with a letter, then
 * 2-19 more letters/digits/underscores (3-20 chars total). Stored raw;
 * displayed with an `@` prefix everywhere.
 */
export const HANDLE_REGEX = /^[a-z][a-z0-9_]{2,19}$/;

/**
 * Handles we don't let users claim. Mostly impersonation hazards
 * (admin/support/etc.) plus brand terms. Length-2 names are excluded
 * by HANDLE_REGEX itself, so 'me' / 'us' don't need to be in here.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'system', 'support',
  'help', 'info', 'mod', 'moderator', 'staff',
  'speakeasy', 'official', 'team', 'app',
  'self', 'anonymous', 'anon',
  'noreply', 'no_reply', 'security', 'abuse',
]);

export const GROUP_ID_REGEX = /^grp-[0-9A-HJKMNP-TV-Z]{26}$/;
export const COMMUNITY_ID_REGEX = /^com-[0-9A-HJKMNP-TV-Z]{26}$/;

export function isHandle(value: string): boolean {
  return HANDLE_REGEX.test(value);
}

/**
 * Single source of truth for handle validation. Returns the failing
 * reason or `undefined` for valid + non-reserved. The API's
 * `/v1/users/availability` endpoint and the `/v1/enroll` route both
 * call this so format/reserved errors are consistent. Caller still has
 * to check the user repo for `'taken'`.
 */
export type HandleRejectReason = 'invalid' | 'reserved';
export function validateHandle(value: string): HandleRejectReason | undefined {
  if (!HANDLE_REGEX.test(value)) return 'invalid';
  if (RESERVED_HANDLES.has(value)) return 'reserved';
  return undefined;
}

export function isUserId(value: string): boolean {
  // Accept either the new handle format or the legacy 3-word id, so
  // any state that survived the handle cutover (e.g. on-disk
  // persisted conversations) still validates through
  // `conversationIdForDirect` and the WS routing layer.
  return HANDLE_REGEX.test(value) || ID_REGEX.test(value);
}

export function newGroupId(): string {
  return `grp-${ulid()}`;
}

export function isGroupId(value: string): boolean {
  return GROUP_ID_REGEX.test(value);
}

export function newCommunityId(): string {
  return `com-${ulid()}`;
}

export function isCommunityId(value: string): boolean {
  return COMMUNITY_ID_REGEX.test(value);
}

export function newMessageId(): string {
  return ulid();
}

export const CALL_ID_REGEX = /^call-[0-9A-HJKMNP-TV-Z]{26}$/;

export function newCallId(): string {
  return `call-${ulid()}`;
}

export function isCallId(value: string): boolean {
  return CALL_ID_REGEX.test(value);
}
