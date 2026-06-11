import { describe, expect, it } from 'vitest';
import { encodeAdd, encodeAddScheme, parseAdd } from './handle-link.js';

describe('handle-link encode/parse', () => {
  it('encodes a handle into the canonical https Universal Link', () => {
    expect(encodeAdd('alice')).toBe('https://speakeasyapp.xyz/add?handle=alice');
  });

  it('strips a leading @ and lowercases', () => {
    expect(encodeAdd('@bob')).toBe('https://speakeasyapp.xyz/add?handle=bob');
    expect(encodeAdd('CarOl')).toBe('https://speakeasyapp.xyz/add?handle=carol');
  });

  it('encodeAddScheme produces the legacy custom-scheme link', () => {
    expect(encodeAddScheme('alice')).toBe('speakeasy://add?handle=alice');
    expect(encodeAddScheme('@CarOl')).toBe('speakeasy://add?handle=carol');
  });

  it('round-trips the canonical (https) link', () => {
    expect(parseAdd(encodeAdd('alice'))).toBe('alice');
    expect(parseAdd(encodeAdd('quiet-blue-river'))).toBe('quiet-blue-river');
  });

  it('still round-trips the legacy custom-scheme link (back-compat)', () => {
    expect(parseAdd(encodeAddScheme('alice'))).toBe('alice');
    expect(parseAdd('speakeasy://add?handle=quiet-blue-river')).toBe('quiet-blue-river');
  });

  // --- https Universal/App Link form ---
  it('parses the https link', () => {
    expect(parseAdd('https://speakeasyapp.xyz/add?handle=alice')).toBe('alice');
  });

  it('https: case-insensitive host the OS may normalize', () => {
    expect(parseAdd('https://SpeakEasyApp.xyz/add?handle=alice')).toBe('alice');
  });

  it('https: accepts a trailing slash before the query', () => {
    expect(parseAdd('https://speakeasyapp.xyz/add/?handle=alice')).toBe('alice');
  });

  it('https: rejects a same-prefix path (address, not add)', () => {
    expect(parseAdd('https://speakeasyapp.xyz/address?handle=alice')).toBeUndefined();
  });

  it('https: rejects a different host', () => {
    expect(parseAdd('https://example.com/add?handle=alice')).toBeUndefined();
    expect(parseAdd('https://evil.speakeasyapp.xyz.example.com/add?handle=alice')).toBeUndefined();
  });

  // --- custom scheme form (unchanged) ---
  it('returns undefined for non-Speakeasy schemes', () => {
    expect(parseAdd('signal://add?handle=alice')).toBeUndefined();
  });

  it('scheme: returns undefined for the wrong host', () => {
    expect(parseAdd('speakeasy://invite?handle=alice')).toBeUndefined();
    expect(parseAdd('speakeasy://address?handle=alice')).toBeUndefined();
  });

  it('scheme: accepts a trailing slash before the query', () => {
    expect(parseAdd('speakeasy://add/?handle=alice')).toBe('alice');
  });

  it('finds handle among multiple query params, order-independent', () => {
    expect(parseAdd('speakeasy://add?ref=qr&handle=alice')).toBe('alice');
    expect(parseAdd('https://speakeasyapp.xyz/add?handle=alice&ref=qr')).toBe('alice');
  });

  it('is case-insensitive on the scheme/host', () => {
    expect(parseAdd('SPEAKEASY://ADD?handle=alice')).toBe('alice');
  });

  it('returns undefined for missing handle param', () => {
    expect(parseAdd('speakeasy://add')).toBeUndefined();
    expect(parseAdd('https://speakeasyapp.xyz/add?other=x')).toBeUndefined();
  });

  it('returns undefined for malformed handles', () => {
    expect(parseAdd('https://speakeasyapp.xyz/add?handle=ab')).toBeUndefined(); // too short
    expect(parseAdd('speakeasy://add?handle=1abc')).toBeUndefined(); // starts with digit
    expect(parseAdd('speakeasy://add?handle=alice!')).toBeUndefined(); // bad char
  });

  it('returns undefined for a totally malformed URL', () => {
    expect(parseAdd('not a url')).toBeUndefined();
    expect(parseAdd('')).toBeUndefined();
  });
});
