import { describe, expect, it } from 'vitest';
import { newMessageId, ulidTimeMs } from './index.js';

describe('ulidTimeMs', () => {
  it('decodes a freshly generated message id near Date.now()', () => {
    const now = Date.now();
    const ms = ulidTimeMs(newMessageId());
    expect(ms).not.toBeNull();
    expect(Math.abs((ms as number) - now)).toBeLessThan(2000);
  });

  it('returns null for a non-ULID string', () => {
    expect(ulidTimeMs('not-a-ulid!')).toBeNull();
  });

  it('returns null for a short string', () => {
    expect(ulidTimeMs('ABC')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(ulidTimeMs(undefined)).toBeNull();
  });

  it('is non-decreasing for ids created in order', () => {
    const a = ulidTimeMs(newMessageId());
    const b = ulidTimeMs(newMessageId());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b as number).toBeGreaterThanOrEqual(a as number);
  });

  it('decodes a known fixed ULID time component', () => {
    // The first 10 Crockford-base32 chars are the 48-bit ms timestamp.
    expect(ulidTimeMs('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(1469922850259);
  });
});
