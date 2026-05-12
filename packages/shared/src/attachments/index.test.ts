import { describe, expect, it } from 'vitest';
import { parseMentions, encodePayload, decodePayload } from './index.js';

describe('parseMentions', () => {
  it('extracts a single @mention', () => {
    expect(parseMentions('hey @alice check this')).toEqual(['alice']);
  });

  it('extracts multiple different @mentions', () => {
    const result = parseMentions('@bob @carol_99 @bob');
    expect(result.sort()).toEqual(['bob', 'carol_99']);
  });

  it('ignores @ at start of another word (no space before)', () => {
    expect(parseMentions('email@example.com')).toEqual([]);
  });

  it('handles @ at start of line', () => {
    expect(parseMentions('@alice hello')).toEqual(['alice']);
  });

  it('skips handles starting with digits', () => {
    expect(parseMentions('@1abc')).toEqual([]);
  });

  it('respects max handle length of 20 chars', () => {
    // 21-char handle: a + 20 more = too long for [a-z][a-z0-9_]{1,19}
    expect(parseMentions('@abcdefghijklmnopqrstu')).toEqual([]);
  });

  it('accepts exactly 20-char handle', () => {
    // a + 19 more = 20 total — within [a-z][a-z0-9_]{1,19}
    expect(parseMentions('@abcdefghijklmnopqrst')).toEqual(['abcdefghijklmnopqrst']);
  });

  it('returns empty for text with no @', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
  });
});

describe('MessagePayload mentions round-trip', () => {
  it('survives encode → decode', () => {
    const payload = { v: 1 as const, text: '@alice check @bob', mentions: ['alice', 'bob'] };
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded.mentions).toEqual(['alice', 'bob']);
  });

  it('handles payload with no mentions (backward compat)', () => {
    const payload = { v: 1 as const, text: 'hello' };
    const encoded = encodePayload(payload);
    const decoded = decodePayload(encoded);
    expect(decoded.mentions).toBeUndefined();
  });
});
