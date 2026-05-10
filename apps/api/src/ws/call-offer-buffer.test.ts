import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createCallOfferBuffer } from './call-offer-buffer.js';

const OFFER = {
  type: 'call_offer' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'b3Nhcg==',
};
const ICE_A = {
  type: 'call_ice' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'aWNlMQ==',
};
const ICE_B = {
  type: 'call_ice' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'aWNlMg==',
};

describe('createCallOfferBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains an offer for the recipient', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    const out = buf.drain('bob');
    expect(out).toEqual([OFFER]);
    expect(buf.size()).toBe(0);
  });

  it('preserves offer + trailing ICE candidates in arrival order', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    buf.put('bob', ICE_A);
    buf.put('bob', ICE_B);
    expect(buf.drain('bob')).toEqual([OFFER, ICE_A, ICE_B]);
  });

  it('ignores ICE that arrives without a matching offer', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', ICE_A);
    expect(buf.drain('bob')).toEqual([]);
  });

  it('ignores ICE whose callId does not match the buffered offer', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    buf.put('bob', { ...ICE_A, callId: 'call-999' });
    // Only the offer remains; the stray ICE was dropped.
    expect(buf.drain('bob')).toEqual([OFFER]);
  });

  it('replaces a prior buffered call when a new offer arrives', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    buf.put('bob', ICE_A);
    const offer2 = { ...OFFER, callId: 'call-002', ciphertext: 'bmV3' };
    buf.put('bob', offer2);
    expect(buf.drain('bob')).toEqual([offer2]);
  });

  it('clear() removes only the matching callId', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    buf.clear('bob', 'call-999'); // wrong id — no-op
    expect(buf.size()).toBe(1);
    buf.clear('bob', 'call-001');
    expect(buf.size()).toBe(0);
    expect(buf.drain('bob')).toEqual([]);
  });

  it('drain() returns [] for a recipient with nothing buffered', () => {
    const buf = createCallOfferBuffer();
    expect(buf.drain('nobody')).toEqual([]);
  });

  it('evicts after TTL', () => {
    const buf = createCallOfferBuffer({ ttlMs: 1000 });
    buf.put('bob', OFFER);
    expect(buf.size()).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(buf.size()).toBe(0);
    expect(buf.drain('bob')).toEqual([]);
  });

  it('isolates entries per recipient', () => {
    const buf = createCallOfferBuffer();
    buf.put('bob', OFFER);
    buf.put('carol', { ...OFFER, callId: 'call-CCC' });
    expect(buf.size()).toBe(2);
    expect(buf.drain('bob')).toEqual([OFFER]);
    expect(buf.drain('carol')).toEqual([{ ...OFFER, callId: 'call-CCC' }]);
  });
});
