import { describe, expect, it } from 'vitest';
import {
  ID_REGEX,
  ID_SPACE_SIZE,
  generateUserId,
  isCommunityId,
  isGroupId,
  isUserId,
  newCommunityId,
  newGroupId,
  newMessageId,
} from './index.js';
import { ADJECTIVES, NOUNS } from '../wordlists/index.js';

describe('wordlists', () => {
  it('have at least 5000 adjectives', () => {
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(5000);
  });

  it('have at least 5000 nouns', () => {
    expect(NOUNS.length).toBeGreaterThanOrEqual(5000);
  });

  it('contain only lowercase letters (no hyphens, spaces, digits)', () => {
    const ok = /^[a-z]+$/;
    for (const w of ADJECTIVES) expect(ok.test(w), `bad adj: ${w}`).toBe(true);
    for (const w of NOUNS) expect(ok.test(w), `bad noun: ${w}`).toBe(true);
  });

  it('have no duplicates within each list', () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
  });
});

describe('generateUserId', () => {
  it('produces ids matching adjective-adjective-noun', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateUserId();
      expect(ID_REGEX.test(id), `bad id: ${id}`).toBe(true);
      expect(isUserId(id)).toBe(true);
    }
  });

  it('uses words from the wordlists', () => {
    const adjSet = new Set(ADJECTIVES);
    const nounSet = new Set(NOUNS);
    for (let i = 0; i < 50; i++) {
      const parts = generateUserId().split('-');
      expect(parts).toHaveLength(3);
      expect(adjSet.has(parts[0]!)).toBe(true);
      expect(adjSet.has(parts[1]!)).toBe(true);
      expect(nounSet.has(parts[2]!)).toBe(true);
    }
  });

  it('has a large enough id space', () => {
    expect(ID_SPACE_SIZE).toBeGreaterThanOrEqual(125_000_000);
  });
});

describe('group / community / message ids', () => {
  it('newGroupId produces grp-<ulid>', () => {
    const id = newGroupId();
    expect(isGroupId(id)).toBe(true);
    expect(id.startsWith('grp-')).toBe(true);
  });

  it('newCommunityId produces com-<ulid>', () => {
    const id = newCommunityId();
    expect(isCommunityId(id)).toBe(true);
    expect(id.startsWith('com-')).toBe(true);
  });

  it('newMessageId produces a 26-char ulid', () => {
    const id = newMessageId();
    expect(id).toHaveLength(26);
  });

  it('group and community id formats are mutually exclusive', () => {
    expect(isGroupId(newCommunityId())).toBe(false);
    expect(isCommunityId(newGroupId())).toBe(false);
  });
});
