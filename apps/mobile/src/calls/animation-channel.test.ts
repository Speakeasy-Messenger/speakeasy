import { describe, expect, it } from 'vitest';
import {
  ANIMATION_CHANNEL_LABEL,
  ANIMATION_FRAME_VERSION,
  decodeAnimationFrame,
  encodeAnimationFrame,
  isFresherSeq,
  type AnimationFrame,
} from './animation-channel.js';
import type { AcousticEvent } from './audio-feature-extractor.js';

const sample: AnimationFrame = {
  seq: 12345,
  amplitude: 0.5,
  pitchNorm: 0.75,
  zcrNorm: 0.25,
  mouthShape: 0.66,
  pitchTrend: 0.4,
  expressiveness: 0.8,
  activity: 0.3,
  event: 'none',
};

describe('encodeAnimationFrame / decodeAnimationFrame', () => {
  it('encodes to exactly 10 bytes (v2 wire-size budget)', () => {
    expect(encodeAnimationFrame(sample).length).toBe(10);
  });

  it('round-trips a representative frame', () => {
    const decoded = decodeAnimationFrame(encodeAnimationFrame(sample));
    expect(decoded?.seq).toBe(12345);
    expect(decoded?.event).toBe('none');
    // Quantization to 1/255: ±1/510 tolerance per unsigned signal.
    expect(decoded?.amplitude).toBeCloseTo(0.5, 2);
    expect(decoded?.pitchNorm).toBeCloseTo(0.75, 2);
    expect(decoded?.zcrNorm).toBeCloseTo(0.25, 2);
    expect(decoded?.mouthShape).toBeCloseTo(0.66, 2);
    expect(decoded?.expressiveness).toBeCloseTo(0.8, 2);
    expect(decoded?.activity).toBeCloseTo(0.3, 2);
    // pitchTrend is signed in [-1, 1] mapped onto a single byte —
    // 1/127.5 quantization, so ±~0.008 tolerance.
    expect(decoded?.pitchTrend).toBeCloseTo(0.4, 1);
  });

  it('round-trips each acoustic event code', () => {
    const events: AcousticEvent[] = ['none', 'laugh', 'sigh', 'gasp', 'hmm'];
    for (const event of events) {
      const decoded = decodeAnimationFrame(
        encodeAnimationFrame({ ...sample, event }),
      );
      expect(decoded?.event).toBe(event);
    }
  });

  it('round-trips the sequence number across the wrap boundary', () => {
    for (const seq of [0, 1, 255, 256, 32767, 65534, 65535]) {
      const decoded = decodeAnimationFrame(
        encodeAnimationFrame({ ...sample, seq }),
      );
      expect(decoded?.seq).toBe(seq);
    }
  });

  it('wraps the sequence at 2^16 (encoder masks the input)', () => {
    const decoded = decodeAnimationFrame(
      encodeAnimationFrame({ ...sample, seq: 0x10000 }),
    );
    expect(decoded?.seq).toBe(0);
  });

  it('clamps unsigned channels to [0,1] at the byte boundary', () => {
    const decoded = decodeAnimationFrame(
      encodeAnimationFrame({
        ...sample,
        amplitude: 2.5,
        pitchNorm: -0.5,
        zcrNorm: 1.5,
        mouthShape: 3.0,
        expressiveness: -0.1,
        activity: 99,
      }),
    );
    expect(decoded?.amplitude).toBe(1);
    expect(decoded?.pitchNorm).toBe(0);
    expect(decoded?.zcrNorm).toBe(1);
    expect(decoded?.mouthShape).toBe(1);
    expect(decoded?.expressiveness).toBe(0);
    expect(decoded?.activity).toBe(1);
  });

  it('clamps pitchTrend to [-1, 1] at the byte boundary', () => {
    const decodedHigh = decodeAnimationFrame(
      encodeAnimationFrame({ ...sample, pitchTrend: 5 }),
    );
    expect(decodedHigh?.pitchTrend).toBeCloseTo(1, 2);
    const decodedLow = decodeAnimationFrame(
      encodeAnimationFrame({ ...sample, pitchTrend: -3 }),
    );
    // -1 maps to byte 0; byte 0 decoded → (0 - 127.5) / 127.5 = -1.
    expect(decodedLow?.pitchTrend).toBeCloseTo(-1, 2);
  });

  it('round-trips a signed pitchTrend of 0 (centered byte 128)', () => {
    const decoded = decodeAnimationFrame(
      encodeAnimationFrame({ ...sample, pitchTrend: 0 }),
    );
    // Symmetric encoding: 0 → 127 or 128 byte, decoded → very close to 0.
    expect(decoded?.pitchTrend).toBeCloseTo(0, 1);
  });

  it('round-trips a signed pitchTrend of -0.5', () => {
    const decoded = decodeAnimationFrame(
      encodeAnimationFrame({ ...sample, pitchTrend: -0.5 }),
    );
    expect(decoded?.pitchTrend).toBeCloseTo(-0.5, 1);
  });

  it('returns undefined for the wrong length', () => {
    expect(decodeAnimationFrame(new Uint8Array(5))).toBeUndefined();
    expect(decodeAnimationFrame(new Uint8Array(9))).toBeUndefined();
    expect(decodeAnimationFrame(new Uint8Array(11))).toBeUndefined();
  });

  it('returns undefined for an unknown wire version (forward-compat)', () => {
    const encoded = encodeAnimationFrame(sample);
    // Corrupt the version nibble to 0xF (future version).
    encoded[0] = (0xf << 4) | (encoded[0]! & 0x0f);
    expect(decodeAnimationFrame(encoded)).toBeUndefined();
  });

  it('returns undefined for an unknown event enum code', () => {
    const encoded = encodeAnimationFrame(sample);
    // Set the event nibble to 0xF (unknown event sentinel — no
    // matching case in decodeAcousticEvent).
    encoded[0] = (encoded[0]! & 0xf0) | 0xf;
    expect(decodeAnimationFrame(encoded)).toBeUndefined();
  });

  it('returns undefined for v1 (legacy) frames so they degrade silently', () => {
    // Fabricate a v1-shaped 6-byte payload: version 1 in high
    // nibble, anything in low nibble. v2 receiver must drop these.
    const legacy = new Uint8Array(6);
    legacy[0] = (1 << 4) | 1; // v1, emotion=baseline
    expect(decodeAnimationFrame(legacy)).toBeUndefined();
  });

  it('wire version is the constant the senders ship', () => {
    expect(ANIMATION_FRAME_VERSION).toBe(2);
  });

  it('exposes the canonical channel label both sides negotiate on', () => {
    expect(ANIMATION_CHANNEL_LABEL).toBe('speakeasy.private-call.animation');
  });
});

describe('isFresherSeq', () => {
  it('accepts any frame when nothing has been seen yet', () => {
    expect(isFresherSeq(undefined, 0)).toBe(true);
    expect(isFresherSeq(undefined, 42)).toBe(true);
  });

  it('accepts a forward step', () => {
    expect(isFresherSeq(100, 101)).toBe(true);
    expect(isFresherSeq(100, 200)).toBe(true);
    expect(isFresherSeq(100, 32767)).toBe(true);
  });

  it('rejects a backward step (late arrival from reorder)', () => {
    expect(isFresherSeq(100, 99)).toBe(false);
    expect(isFresherSeq(100, 50)).toBe(false);
    expect(isFresherSeq(100, 100)).toBe(false);
  });

  it('handles the 2^16 wrap as forward progress', () => {
    // Last seen 65535; new is 0 — that's seq+1 mod 2^16.
    expect(isFresherSeq(65535, 0)).toBe(true);
    expect(isFresherSeq(65535, 10)).toBe(true);
    expect(isFresherSeq(65530, 5)).toBe(true);
  });

  it('rejects a wrap-distance > 32768 (treats as backward)', () => {
    // Last seen 0; incoming 40000 — that's "back by 25536" mod 2^16
    // in the half-window sense. Reject as out-of-order.
    expect(isFresherSeq(0, 40000)).toBe(false);
  });
});
