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
 * User-chosen handle: lowercase ASCII, 3-20 chars total. Users pick
 * any single-token handle they want, subject only to this format
 * constraint — the server doesn't dictate shape beyond the regex.
 *
 * The regex enforces:
 *  - first char: letter (no leading digit or separator)
 *  - last char: letter or digit (no trailing separator)
 *  - 1–18 middle chars from `[a-z0-9._-]` (letters, digits, underscore,
 *    dot, hyphen — the three separators that read cleanly in a handle).
 *
 * Accepted examples: `alice`, `user_2026`, `midnight_traveler`,
 * `amber-quiet-fox`, `dr.who`. Rejected examples: `al ice` (space),
 * `1abc` (leading digit), `Alice` (uppercase), `-abc` (leading
 * separator), `a--b` (consecutive separators — `validateHandle`).
 *
 * `validateHandle` adds the additional check that no two separators
 * appear consecutively (the regex would get unwieldy; a single
 * `/[._-]{2}/` post-filter is clearer).
 *
 * Stored raw; displayed with an `@` prefix everywhere.
 */
export const HANDLE_REGEX = /^[a-z][a-z0-9._-]{1,18}[a-z0-9]$/;

/** Two-or-more consecutive separators reject post-regex. Spec §2.3.2:
 * "no double symbols" (`..`, `--`, `__`, `.-`, `-_`, etc.). */
const CONSECUTIVE_SEPARATORS = /[._-]{2}/;

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
  // Special-cased handle for in-app feedback. The mobile client routes
  // messages addressed to @feedback through POST /v1/feedback (non-E2E,
  // opt-in by the user) and the API server's availability route returns
  // it as `taken` so users can reach the chat. Reserving it here means
  // no user can claim it via /v1/enroll.
  'feedback',
  // Broadcast bot. A seeded bot user row; the server fans release
  // announcements out from @speaker to every user. Reserved so nobody
  // can enroll it.
  'speaker',
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
  if (CONSECUTIVE_SEPARATORS.test(value)) return 'invalid';
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

/**
 * Decode the millisecond timestamp embedded in a ULID's first 10
 * characters (Crockford base32, 48-bit time component). Returns null
 * for a non-ULID / unparseable id so callers can fall back.
 */
export function ulidTimeMs(id: string): number | null {
  if (typeof id !== 'string' || id.length < 10) return null;
  const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ms = 0;
  const head = id.slice(0, 10).toUpperCase();
  for (let i = 0; i < head.length; i++) {
    const idx = ENC.indexOf(head[i]!);
    if (idx === -1) return null;
    ms = ms * 32 + idx;
  }
  return ms;
}

/** A bare ULID, as produced by `newMessageId()`. */
export const MESSAGE_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a well-formed message id (a bare ULID). */
export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_REGEX.test(value);
}

export const CALL_ID_REGEX = /^call-[0-9A-HJKMNP-TV-Z]{26}$/;

export function newCallId(): string {
  return `call-${ulid()}`;
}

export function isCallId(value: string): boolean {
  return CALL_ID_REGEX.test(value);
}

/**
 * The reserved handle used for in-app feedback. Messages addressed to
 * this user on the mobile client take a separate (non-E2E) HTTP path
 * — see `POST /v1/feedback`. The server's availability route
 * special-cases this handle as "taken" so users can't claim it but
 * can still send messages to it.
 */
export const FEEDBACK_HANDLE = 'feedback';

export function isFeedbackHandle(handle: string): boolean {
  return handle.toLowerCase() === FEEDBACK_HANDLE;
}

/**
 * The broadcast bot handle. A seeded bot user; the server sends
 * release announcements from @speaker to every user. Plaintext, not
 * E2E — the client renders @speaker messages without Signal decrypt.
 */
export const SPEAKER_HANDLE = 'speaker';

export function isSpeakerHandle(handle: string): boolean {
  return handle.toLowerCase() === SPEAKER_HANDLE;
}

export function newFeedbackId(): string {
  return `fb-${ulid()}`;
}
