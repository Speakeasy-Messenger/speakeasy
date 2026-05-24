import { describe, expect, it } from 'vitest';
import {
  ANIMATION_CHANNEL_LABEL,
  ANIMATION_FRAME_VERSION,
  decodeAnimationFrame,
  encodeAnimationFrame,
  isFresherSeq,
  type AnimationFrame,
} from './animation-channel.js';

const sample: AnimationFrame = {
  seq: 12345,
  amplitude: 0.5,
  emotionState: 'excited',
  pitchNorm: 0.75,
  zcrNorm: 0.25,
};

describe('encodeAnimationFrame / decodeAnimationFrame', () => {
  it('encodes to exactly 6 bytes (matches the plan budget)', () => {
    expect(encodeAnimationFrame(sample).length).toBe(6);
  });

  it('round-trips a representative frame', () => {
    const decoded = decodeAnimationFrame(encodeAnimationFrame(sample));
    expect(decoded?.seq).toBe(12345);
    expect(decoded?.emotionState).toBe('excited');
    // Quantization to 1/255: ±1/510 tolerance per signal.
    expect(decoded?.amplitude).toBeCloseTo(0.5, 2);
    expect(decoded?.pitchNorm).toBeCloseTo(0.75, 2);
    expect(decoded?.zcrNorm).toBeCloseTo(0.25, 2);
  });

  it('round-trips each emotion state value', () => {
    for (const state of ['baseline', 'excited', 'calm'] as const) {
      const decoded = decodeAnimationFrame(
        encodeAnimationFrame({ ...sample, emotionState: state }),
      );
      expect(decoded?.emotionState).toBe(state);
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

  it('clamps amplitude/pitch/zcr to [0,1] at the byte boundary', () => {
    const decoded = decodeAnimationFrame(
      encodeAnimationFrame({
        ...sample,
        amplitude: 2.5,
        pitchNorm: -0.5,
        zcrNorm: 1.5,
      }),
    );
    expect(decoded?.amplitude).toBe(1);
    expect(decoded?.pitchNorm).toBe(0);
    expect(decoded?.zcrNorm).toBe(1);
  });

  it('returns undefined for the wrong length', () => {
    expect(decodeAnimationFrame(new Uint8Array(5))).toBeUndefined();
    expect(decodeAnimationFrame(new Uint8Array(7))).toBeUndefined();
  });

  it('returns undefined for an unknown wire version (forward-compat)', () => {
    const encoded = encodeAnimationFrame(sample);
    // Corrupt the version nibble to 0xF (future version).
    encoded[0] = (0xf << 4) | (encoded[0]! & 0x0f);
    expect(decodeAnimationFrame(encoded)).toBeUndefined();
  });

  it('returns undefined for an unknown emotion enum code', () => {
    const encoded = encodeAnimationFrame(sample);
    // Wipe the emotion nibble to 0 (sentinel for unknown).
    encoded[0] = (encoded[0]! & 0xf0) | 0x0;
    expect(decodeAnimationFrame(encoded)).toBeUndefined();
  });

  it('wire version is the constant the senders ship', () => {
    expect(ANIMATION_FRAME_VERSION).toBe(1);
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
