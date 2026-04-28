import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { ADJECTIVES, NOUNS } from '../wordlists/index.js';

export const ID_REGEX = /^[a-z]+-[a-z]+-[a-z]+$/;
export const GROUP_ID_REGEX = /^grp-[0-9A-HJKMNP-TV-Z]{26}$/;
export const COMMUNITY_ID_REGEX = /^com-[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Generate a candidate user ID in `adjective-adjective-noun` form.
 * Server must verify uniqueness against the users table before issuing.
 */
export function generateUserId(): string {
  const adj1 = ADJECTIVES[randomInt(ADJECTIVES.length)]!;
  const adj2 = ADJECTIVES[randomInt(ADJECTIVES.length)]!;
  const noun = NOUNS[randomInt(NOUNS.length)]!;
  return `${adj1}-${adj2}-${noun}`;
}

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

export const ID_SPACE_SIZE = ADJECTIVES.length * ADJECTIVES.length * NOUNS.length;
