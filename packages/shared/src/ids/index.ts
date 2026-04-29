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

export const ID_REGEX = /^[a-z]+-[a-z]+-[a-z]+$/;
export const GROUP_ID_REGEX = /^grp-[0-9A-HJKMNP-TV-Z]{26}$/;
export const COMMUNITY_ID_REGEX = /^com-[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUserId(value: string): boolean {
  return ID_REGEX.test(value);
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
