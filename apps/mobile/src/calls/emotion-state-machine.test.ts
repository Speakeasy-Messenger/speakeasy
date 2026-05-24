import { describe, expect, it } from 'vitest';
import {
  EmotionStateMachine,
  renderParamsFor,
  type EmotionState,
} from './emotion-state-machine.js';
import type { NormalizedFeatures } from './audio-feature-extractor.js';

function f(loudness: number, pitchNorm: number, zcrNorm = 0.5): NormalizedFeatures {
  return { loudness, pitchNorm, zcrNorm };
}

describe('EmotionStateMachine', () => {
  it('starts in baseline', () => {
    const m = new EmotionStateMachine();
    expect(m.current).toBe('baseline');
  });

  it('enters excited when both loudness AND pitch exceed 0.6', () => {
    const m = new EmotionStateMachine();
    expect(m.push(f(0.7, 0.7))).toBe('excited');
  });

  it('does NOT enter excited when only loudness OR only pitch exceeds 0.6', () => {
    expect(new EmotionStateMachine().push(f(0.7, 0.5))).toBe('baseline');
    expect(new EmotionStateMachine().push(f(0.5, 0.7))).toBe('baseline');
  });

  it('enters calm when both loudness < 0.3 AND pitch < 0.4', () => {
    const m = new EmotionStateMachine();
    expect(m.push(f(0.2, 0.3))).toBe('calm');
  });

  it('does NOT enter calm when only one signal is low', () => {
    expect(new EmotionStateMachine().push(f(0.2, 0.5))).toBe('baseline');
    expect(new EmotionStateMachine().push(f(0.5, 0.3))).toBe('baseline');
  });

  describe('hysteresis on excited (locked /plan-design-review D8)', () => {
    function intoExcited(): EmotionStateMachine {
      const m = new EmotionStateMachine();
      m.push(f(0.7, 0.7)); // → excited
      return m;
    }

    it('stays excited when signals straddle the 0.6 enter threshold but stay above 0.5', () => {
      const m = intoExcited();
      // Both signals dip below the enter threshold (0.6) but stay
      // above the leave threshold (0.5). Without hysteresis the
      // state would flicker to baseline; with hysteresis it stays
      // excited.
      expect(m.push(f(0.55, 0.55))).toBe('excited');
      expect(m.push(f(0.58, 0.51))).toBe('excited');
      expect(m.push(f(0.51, 0.59))).toBe('excited');
    });

    it('leaves excited when EITHER signal drops below 0.5', () => {
      const m = intoExcited();
      expect(m.push(f(0.49, 0.7))).toBe('baseline'); // loudness drops
      const m2 = intoExcited();
      expect(m2.push(f(0.7, 0.49))).toBe('baseline'); // pitch drops
    });

    it('the 0.55/0.55 dead-band would flicker WITHOUT hysteresis (regression sentinel)', () => {
      // Simulate a sentence where natural prosody scoops through the
      // 0.5–0.6 band repeatedly. With hysteresis: stays excited the
      // whole sentence. Without: would oscillate.
      const m = intoExcited();
      const trace: EmotionState[] = [];
      for (let i = 0; i < 10; i++) {
        // Alternate just above and just below the enter threshold.
        const loud = i % 2 === 0 ? 0.62 : 0.55;
        const pitch = i % 2 === 0 ? 0.62 : 0.55;
        trace.push(m.push(f(loud, pitch)));
      }
      // Every reading is 'excited' — no flicker.
      expect(new Set(trace)).toEqual(new Set(['excited']));
    });
  });

  describe('hysteresis on calm', () => {
    function intoCalm(): EmotionStateMachine {
      const m = new EmotionStateMachine();
      m.push(f(0.2, 0.3)); // → calm
      return m;
    }

    it('stays calm in the 0.3-0.4 enter / 0.4-0.5 leave dead-band', () => {
      const m = intoCalm();
      expect(m.push(f(0.35, 0.35))).toBe('calm');
      expect(m.push(f(0.39, 0.49))).toBe('calm');
    });

    it('leaves calm when loudness exceeds 0.4', () => {
      const m = intoCalm();
      expect(m.push(f(0.45, 0.3))).toBe('baseline');
    });

    it('leaves calm when pitch exceeds 0.5', () => {
      const m = intoCalm();
      expect(m.push(f(0.2, 0.55))).toBe('baseline');
    });
  });

  it('does not allow a direct excited → calm transition (must pass through baseline)', () => {
    const m = new EmotionStateMachine();
    m.push(f(0.7, 0.7)); // → excited
    expect(m.current).toBe('excited');
    // Drop everything to calm-range. Excited → baseline (leave
    // threshold), THEN next push baseline → calm.
    expect(m.push(f(0.1, 0.1))).toBe('baseline');
    expect(m.push(f(0.1, 0.1))).toBe('calm');
  });
});

describe('renderParamsFor', () => {
  it('baseline is neutral (1.0 eyeScale, 5s blink, 1.0 amp boost)', () => {
    expect(renderParamsFor('baseline')).toEqual({
      eyeScale: 1.0,
      blinkIntervalSec: 5,
      amplitudeBoost: 1.0,
    });
  });

  it('excited widens eyes, speeds blink, boosts amplitude (locked values)', () => {
    expect(renderParamsFor('excited')).toEqual({
      eyeScale: 1.15,
      blinkIntervalSec: 3,
      amplitudeBoost: 1.2,
    });
  });

  it('calm relaxes amplitude, slows blink (locked values)', () => {
    expect(renderParamsFor('calm')).toEqual({
      eyeScale: 1.0,
      blinkIntervalSec: 8,
      amplitudeBoost: 0.85,
    });
  });
});
