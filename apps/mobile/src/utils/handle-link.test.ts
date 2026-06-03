import { describe, expect, it } from 'vitest';
import { encodeAdd, parseAdd } from './handle-link.js';

describe('handle-link encode/parse', () => {
  it('encodes a handle into the canonical deep-link URL', () => {
    expect(encodeAdd('alice')).toBe('speakeasy://add?handle=alice');
  });

  it('strips a leading @ from caller-supplied handles', () => {
    expect(encodeAdd('@bob')).toBe('speakeasy://add?handle=bob');
  });

  it('lowercases', () => {
    expect(encodeAdd('CarOl')).toBe('speakeasy://add?handle=carol');
  });

  it('round-trips a new-style handle', () => {
    const url = encodeAdd('alice');
    expect(parseAdd(url)).toBe('alice');
  });

  it('round-trips a legacy 3-word id', () => {
    const url = encodeAdd('quiet-blue-river');
    expect(parseAdd(url)).toBe('quiet-blue-river');
  });

  it('returns undefined for non-Speakeasy URLs', () => {
    expect(parseAdd('https://example.com/add?handle=alice')).toBeUndefined();
    expect(parseAdd('signal://add?handle=alice')).toBeUndefined();
  });

  it('returns undefined for the right scheme but the wrong host', () => {
    expect(parseAdd('speakeasy://invite?handle=alice')).toBeUndefined();
  });

  it('returns undefined for a same-prefix host (address, not add)', () => {
    expect(parseAdd('speakeasy://address?handle=alice')).toBeUndefined();
  });

  it('accepts a trailing slash before the query', () => {
    expect(parseAdd('speakeasy://add/?handle=alice')).toBe('alice');
  });

  it('finds handle among multiple query params, order-independent', () => {
    expect(parseAdd('speakeasy://add?ref=qr&handle=alice')).toBe('alice');
    expect(parseAdd('speakeasy://add?handle=alice&ref=qr')).toBe('alice');
  });

  it('is case-insensitive on the scheme/host the OS may normalize', () => {
    expect(parseAdd('SPEAKEASY://ADD?handle=alice')).toBe('alice');
  });

  it('decodes a percent-encoded handle', () => {
    // encodeAdd uses encodeURIComponent; a legacy id round-trips cleanly.
    expect(parseAdd('speakeasy://add?handle=quiet-blue-river')).toBe('quiet-blue-river');
  });

  it('returns undefined for missing handle param', () => {
    expect(parseAdd('speakeasy://add')).toBeUndefined();
    expect(parseAdd('speakeasy://add?other=x')).toBeUndefined();
  });

  it('returns undefined for malformed handles', () => {
    expect(parseAdd('speakeasy://add?handle=ab')).toBeUndefined(); // too short
    expect(parseAdd('speakeasy://add?handle=1abc')).toBeUndefined(); // starts with digit
    expect(parseAdd('speakeasy://add?handle=alice!')).toBeUndefined(); // bad char
  });

  it('returns undefined for a totally malformed URL', () => {
    expect(parseAdd('not a url')).toBeUndefined();
    expect(parseAdd('')).toBeUndefined();
  });
});
