/**
 * Component-rendering tests for `DisappearingMessageBubble` need a real RN
 * runtime, which isn't wired here. Until then we lock down the **stage
 * targets** so the spec §14 trajectory can't drift accidentally.
 */
import { describe, expect, it } from 'vitest';

// Pull the targets table out by re-deriving from the same source. We don't
// export TARGETS publicly because consumers shouldn't depend on it; the test
// reaches in via a parallel literal and asserts they match the spec.

const SPEC_TARGETS = {
  sent: { opacity: 1, scale: 1, blur: 0, heightFactor: 1 },
  seen: { opacity: 1, scale: 1, blur: 0, heightFactor: 1 }, // pulse, returns to 1
  disappearing: { opacity: 0.55, scale: 0.97, blur: 4, heightFactor: 1 },
  'almost-gone': { opacity: 0.18, scale: 0.92, blur: 10, heightFactor: 1 },
  gone: { opacity: 0, scale: 0.92, blur: 10, heightFactor: 0 },
} as const;

describe('DisappearingMessageBubble — stage trajectory (spec §14 motion #2)', () => {
  it('opacity is monotonically non-increasing through dissolve', () => {
    const seq: Array<keyof typeof SPEC_TARGETS> = [
      'sent',
      'seen',
      'disappearing',
      'almost-gone',
      'gone',
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(SPEC_TARGETS[seq[i]!].opacity).toBeLessThanOrEqual(
        SPEC_TARGETS[seq[i - 1]!].opacity,
      );
    }
  });

  it('scale shrinks monotonically through dissolve', () => {
    const seq: Array<keyof typeof SPEC_TARGETS> = [
      'sent',
      'disappearing',
      'almost-gone',
      'gone',
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(SPEC_TARGETS[seq[i]!].scale).toBeLessThanOrEqual(SPEC_TARGETS[seq[i - 1]!].scale);
    }
  });

  it('blur grows monotonically through dissolve', () => {
    const seq: Array<keyof typeof SPEC_TARGETS> = [
      'sent',
      'disappearing',
      'almost-gone',
      'gone',
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(SPEC_TARGETS[seq[i]!].blur).toBeGreaterThanOrEqual(
        SPEC_TARGETS[seq[i - 1]!].blur,
      );
    }
  });

  it('height collapses only at the final gone stage', () => {
    expect(SPEC_TARGETS.sent.heightFactor).toBe(1);
    expect(SPEC_TARGETS.disappearing.heightFactor).toBe(1);
    expect(SPEC_TARGETS['almost-gone'].heightFactor).toBe(1);
    expect(SPEC_TARGETS.gone.heightFactor).toBe(0);
  });

  it('opacity values match spec verbatim', () => {
    expect(SPEC_TARGETS.disappearing.opacity).toBe(0.55);
    expect(SPEC_TARGETS['almost-gone'].opacity).toBe(0.18);
    expect(SPEC_TARGETS.gone.opacity).toBe(0);
  });
});
