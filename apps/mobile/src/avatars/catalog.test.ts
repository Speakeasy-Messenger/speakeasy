/**
 * Catalog shape contract — guards against the spec drift class of
 * regression we hit during rc.6 design (raven appearing in both Free
 * and Rare, mismatched SKU strings, etc.).
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  FREE_AVATARS,
  LEGENDARIES,
  RARES,
  descriptorFor,
} from './catalog.js';

describe('avatar catalog', () => {
  it('has 12 free + 12 rare + 4 legendary = 28', () => {
    expect(FREE_AVATARS.length).toBe(12);
    expect(RARES.length).toBe(12);
    expect(LEGENDARIES.length).toBe(4);
    expect(CATALOG.length).toBe(28);
  });

  it('has unique ids across the entire catalog', () => {
    const ids = CATALOG.map((e) => e.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });

  it('every paid entry has a sku id and a display price', () => {
    for (const entry of [...RARES, ...LEGENDARIES]) {
      expect(entry.skuId).toBeTruthy();
      expect(entry.skuId).toMatch(/^com\.speakeasy\.avatar\.(rare|legendary)\./);
      expect(entry.displayPrice).toBeTruthy();
    }
  });

  it('every free entry has no sku id', () => {
    for (const entry of FREE_AVATARS) {
      expect(entry.skuId).toBeUndefined();
      expect(entry.tier).toBe('free');
    }
  });

  it('every paid entry has a signature effect id', () => {
    for (const entry of [...RARES, ...LEGENDARIES]) {
      expect(entry.signatureEffect).toBeTruthy();
    }
  });

  it('every legendary has a signature color (the four-color discipline relax)', () => {
    for (const entry of LEGENDARIES) {
      expect(entry.signatureColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('descriptorFor returns the expected entry by id', () => {
    expect(descriptorFor('lynx')?.tier).toBe('rare');
    expect(descriptorFor('dragon')?.tier).toBe('legendary');
    expect(descriptorFor('fox')?.tier).toBe('free');
    expect(descriptorFor('does-not-exist')).toBeUndefined();
  });

  it("rc.6 rename: 'raven' is now a rare, 'pigeon' is the free common bird", () => {
    expect(descriptorFor('raven')?.tier).toBe('rare');
    expect(descriptorFor('pigeon')?.tier).toBe('free');
  });

  it('rare prices are all $9.99 and legendary prices are all $99.99 (display fallback)', () => {
    for (const entry of RARES) {
      expect(entry.displayPrice).toBe('$9.99');
    }
    for (const entry of LEGENDARIES) {
      expect(entry.displayPrice).toBe('$99.99');
    }
  });
});
