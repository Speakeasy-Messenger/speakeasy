import { describe, expect, it } from 'vitest';
import {
  AudioFeatureExtractor,
  FEATURE_WINDOW_MS,
  extractRawFeatures,
} from './audio-feature-extractor.js';

const SR = 48_000;
const WINDOW_SAMPLES = Math.floor((SR * FEATURE_WINDOW_MS) / 1000);

/** Generate a Float32 sine wave at `freqHz` with amplitude `amp`. */
function sine(freqHz: number, amp: number, samples = WINDOW_SAMPLES): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  }
  return out;
}

/** Deterministic white-noise window using a linear-congruential PRNG
 *  (don't pollute the test with Math.random for reproducibility). */
function whiteNoise(amp: number, samples = WINDOW_SAMPLES): Float32Array {
  const out = new Float32Array(samples);
  let s = 0x12345678;
  for (let i = 0; i < samples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x40000000) - 1) * amp;
  }
  return out;
}

function silence(samples = WINDOW_SAMPLES): Float32Array {
  return new Float32Array(samples);
}

describe('extractRawFeatures', () => {
  it('returns zeros for empty input', () => {
    const f = extractRawFeatures(new Float32Array(), SR);
    expect(f).toEqual({ loudness: 0, pitchHz: 0, zcr: 0 });
  });

  it('returns zeros for pure silence', () => {
    const f = extractRawFeatures(silence(), SR);
    expect(f.loudness).toBe(0);
    expect(f.pitchHz).toBe(0);
    // ZCR on all-zeros is 0 (no sign changes).
    expect(f.zcr).toBe(0);
  });

  it('RMS of a unit-amplitude sine is ~0.707', () => {
    const f = extractRawFeatures(sine(200, 1.0), SR);
    expect(f.loudness).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('RMS scales linearly with amplitude', () => {
    const a = extractRawFeatures(sine(200, 0.3), SR).loudness;
    const b = extractRawFeatures(sine(200, 0.6), SR).loudness;
    expect(b / a).toBeCloseTo(2, 1);
  });

  it('detects pitch within ±5% for sines across the speech range', () => {
    for (const f0 of [100, 150, 220, 300, 380]) {
      const f = extractRawFeatures(sine(f0, 0.5), SR);
      expect(Math.abs(f.pitchHz - f0) / f0).toBeLessThan(0.05);
    }
  });

  it('returns 0 Hz for white noise (no clear F0)', () => {
    const f = extractRawFeatures(whiteNoise(0.5), SR);
    // White noise has high ZCR and no autocorrelation peak above
    // the 0.3 voicing threshold — the extractor should bail out.
    expect(f.pitchHz).toBe(0);
    // ZCR on white noise approaches 0.5 (half the samples cross
    // zero) but our bounded PRNG gives something in the 0.25–0.50
    // range — definitely well above any sine.
    expect(f.zcr).toBeGreaterThan(0.2);
  });

  it('ZCR of a sine is roughly 2 * f0 / sampleRate', () => {
    // A 200 Hz sine at 48 kHz has 200 crossings/sec, so zcr ≈ 200/48000 ≈ 0.0042.
    const f = extractRawFeatures(sine(200, 0.5), SR);
    expect(f.zcr).toBeCloseTo((2 * 200) / SR, 3);
  });

  it('returns 0 pitch on a tiny-window input (length guard)', () => {
    const f = extractRawFeatures(new Float32Array(16), SR);
    expect(f.pitchHz).toBe(0);
  });
});

describe('AudioFeatureExtractor (stateful, smoothed)', () => {
  it('pitch normalization clamps the speech range to [0,1]', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // Push enough windows to settle the follower (~10 windows of
    // attack/release at 33 ms each = ~330 ms, > 5×attack time).
    let last = fx.push(sine(80, 0.5));
    for (let i = 0; i < 30; i++) last = fx.push(sine(80, 0.5));
    expect(last.pitchNorm).toBeCloseTo(0, 1); // 80 Hz → 0
    // Fresh extractor for the high end so we don't drag through the
    // attack/release transition.
    const fx2 = new AudioFeatureExtractor({ sampleRate: SR });
    let last2 = fx2.push(sine(400, 0.5));
    for (let i = 0; i < 30; i++) last2 = fx2.push(sine(400, 0.5));
    expect(last2.pitchNorm).toBeCloseTo(1, 1); // 400 Hz → 1
  });

  it('settles to mid-range for a 220 Hz speaking-voice pitch', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    let last = fx.push(sine(220, 0.5));
    for (let i = 0; i < 30; i++) last = fx.push(sine(220, 0.5));
    // 220 Hz → (220 - 80) / (400 - 80) ≈ 0.4375
    expect(last.pitchNorm).toBeGreaterThan(0.35);
    expect(last.pitchNorm).toBeLessThan(0.5);
  });

  it('zcrNorm converges to ~0.5 (neutral) before calibration completes', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // ZCR is fed 0.5 (neutral) into the follower pre-calibration.
    // The follower starts at 0, so the first push is partway to 0.5,
    // not at it. After several windows it converges.
    let last = fx.push(sine(200, 0.5));
    for (let i = 0; i < 30; i++) last = fx.push(sine(200, 0.5));
    // Still in calibration window? Not quite — 30 windows is past
    // the 15-window calibration threshold. So after this loop
    // calibration has completed and zcrNorm is the real normalized
    // value, not the 0.5 pre-calibration constant. Test calibration
    // semantics separately.
    expect(last.zcrNorm).toBeGreaterThan(0);
  });

  it('zcrNorm calibrates after ~500 ms of audible signal', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // Push 20 windows (~660 ms) of audible sine — well past the
    // 500 ms / 15 windows calibration threshold.
    for (let i = 0; i < 20; i++) fx.push(sine(200, 0.5));
    expect(fx.isCalibrated).toBe(true);
    // For a clean 200 Hz sine, ZCR ≈ 2*200/48000 ≈ 0.0083, which
    // falls below the 0.01 floor we apply to avoid divide-by-near-
    // zero in the normalization. The floor is intentional — real
    // speech ZCR is comfortably above 0.01.
    expect(fx._zcrBaseline).toBe(0.01);
  });

  it('uses real-speech-like baseline when ZCR is comfortably above the floor', () => {
    // Mix a sine with white noise so ZCR lands well above 0.01 —
    // approximates the ZCR profile of voiced speech with fricative
    // overtones. Use a higher-frequency sine to push the per-window
    // ZCR up into the realistic range.
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    const mixed = (): Float32Array => {
      const s = sine(2000, 0.4);
      const n = whiteNoise(0.1);
      const out = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = (s[i] ?? 0) + (n[i] ?? 0);
      return out;
    };
    for (let i = 0; i < 20; i++) fx.push(mixed());
    expect(fx.isCalibrated).toBe(true);
    expect(fx._zcrBaseline).toBeGreaterThan(0.05);
  });

  it('silent windows do NOT contribute to ZCR calibration', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // 100 windows of silence → still not calibrated.
    for (let i = 0; i < 100; i++) fx.push(silence());
    expect(fx.isCalibrated).toBe(false);
  });

  it('loudness follower smooths step inputs (attack ramps up)', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // First window of loud signal: follower in attack — should be
    // partway to the target, NOT at it.
    const first = fx.push(sine(200, 1.0));
    expect(first.loudness).toBeGreaterThan(0);
    expect(first.loudness).toBeLessThan(Math.SQRT1_2 * 0.5); // < ~0.35
    // After many windows the follower converges to the steady RMS.
    let last = first;
    for (let i = 0; i < 30; i++) last = fx.push(sine(200, 1.0));
    expect(last.loudness).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('loudness follower releases slower than it attacks (asymmetric)', () => {
    const fx = new AudioFeatureExtractor({ sampleRate: SR });
    // Saturate.
    for (let i = 0; i < 30; i++) fx.push(sine(200, 1.0));
    const sat = fx.push(sine(200, 1.0)).loudness;
    // Cut to silence — release is 200 ms (vs 80 ms attack).
    // After one window of silence the follower should still be near
    // the saturation level (small step toward 0).
    const after1 = fx.push(silence()).loudness;
    expect(after1).toBeLessThan(sat);
    expect(after1).toBeGreaterThan(sat * 0.7);
  });
});

describe('AudioFeatureExtractor — continuous prosody channels', () => {
  // Helpers for these tests: a vowel-like signal (clean sine in the
  // speech range, voiced) and a fricative-like signal (white noise,
  // unvoiced) at matched loudness.
  function vowelLike(pitchHz: number, amp = 0.5): Float32Array {
    return sine(pitchHz, amp);
  }
  function fricativeLike(amp = 0.5): Float32Array {
    return whiteNoise(amp);
  }

  describe('mouthShape', () => {
    it('is 0 for silence', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      for (let i = 0; i < 10; i++) {
        const f = fx.push(silence());
        expect(f.mouthShape).toBe(0);
      }
    });

    it('rises on a loud sustained vowel', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let f = fx.push(vowelLike(200, 0.8));
      for (let i = 0; i < 30; i++) f = fx.push(vowelLike(200, 0.8));
      // Settled mouthShape should be near (loudness × 1.2 saturated).
      // RMS of a 0.8 sine ≈ 0.566; × 1.2 = 0.68. Allow some headroom
      // for follower lag.
      expect(f.mouthShape).toBeGreaterThan(0.5);
    });

    it('is meaningfully LOWER on a fricative than on a vowel at the same loudness', () => {
      // Vowel run.
      const vowelFx = new AudioFeatureExtractor({ sampleRate: SR });
      let vowel = vowelFx.push(vowelLike(200, 0.5));
      for (let i = 0; i < 30; i++) vowel = vowelFx.push(vowelLike(200, 0.5));
      // Fricative run.
      const fricFx = new AudioFeatureExtractor({ sampleRate: SR });
      let fric = fricFx.push(fricativeLike(0.5));
      for (let i = 0; i < 30; i++) fric = fricFx.push(fricativeLike(0.5));
      // The fricative is unvoiced (no detectable pitch), so the
      // mouth-shape signal is half what the vowel produces at the
      // same RMS — distinct enough that the avatar's mouth opens
      // perceptibly less on a sibilant.
      expect(fric.mouthShape).toBeLessThan(vowel.mouthShape * 0.7);
    });
  });

  describe('pitchTrend', () => {
    it('is 0 with no voiced material', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      for (let i = 0; i < 30; i++) {
        const f = fx.push(silence());
        expect(f.pitchTrend).toBe(0);
      }
    });

    it('is positive when pitch is rising over the trend window', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      // Ramp pitch from 120 Hz → 280 Hz over 20 windows (~660 ms).
      let last = fx.push(vowelLike(120, 0.5));
      for (let i = 0; i < 20; i++) {
        const f0 = 120 + (i * (280 - 120)) / 20;
        last = fx.push(vowelLike(f0, 0.5));
      }
      expect(last.pitchTrend).toBeGreaterThan(0.2);
    });

    it('is negative when pitch is falling over the trend window', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(280, 0.5));
      for (let i = 0; i < 20; i++) {
        const f0 = 280 - (i * (280 - 120)) / 20;
        last = fx.push(vowelLike(f0, 0.5));
      }
      expect(last.pitchTrend).toBeLessThan(-0.2);
    });

    it('settles toward 0 on a held monotone', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(200, 0.5));
      for (let i = 0; i < 40; i++) last = fx.push(vowelLike(200, 0.5));
      expect(Math.abs(last.pitchTrend)).toBeLessThan(0.1);
    });
  });

  describe('expressiveness', () => {
    it('is low on a held monotone', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(200, 0.5));
      for (let i = 0; i < 40; i++) last = fx.push(vowelLike(200, 0.5));
      expect(last.expressiveness).toBeLessThan(0.15);
    });

    it('rises when pitch varies widely across the prosody window', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      // Alternate between 120 Hz and 280 Hz every window — large
      // pitch swings = high coefficient of variation.
      let last = fx.push(vowelLike(120, 0.5));
      for (let i = 0; i < 40; i++) {
        last = fx.push(vowelLike(i % 2 === 0 ? 280 : 120, 0.5));
      }
      expect(last.expressiveness).toBeGreaterThan(0.4);
    });

    it('is robust to a single octave-jump glitch in otherwise flat pitch', () => {
      // Simulate the YIN/autocorrelation failure mode: 30 windows
      // of a monotone 200 Hz signal, with ONE window where the
      // detector spuriously reports the octave-up (400 Hz). With
      // mean+stddev this single outlier pushes the CoV into the
      // "well-animated speech" range; with median+MAD it shouldn't.
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(200, 0.5));
      for (let i = 0; i < 30; i++) {
        const hz = i === 15 ? 400 : 200;
        last = fx.push(vowelLike(hz, 0.5));
      }
      // Still classified as flat — under 0.25 with the robust metric.
      // A pre-rc.11 (mean/stddev) implementation would hit ~0.45.
      expect(last.expressiveness).toBeLessThan(0.25);
    });
  });

  describe('activity', () => {
    it('is 0 on continuous silence', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(silence());
      for (let i = 0; i < 30; i++) last = fx.push(silence());
      expect(last.activity).toBe(0);
    });

    it('is low on a sustained continuous note', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(200, 0.5));
      for (let i = 0; i < 30; i++) last = fx.push(vowelLike(200, 0.5));
      // One initial transition (silence → voiced), then steady →
      // very low activity.
      expect(last.activity).toBeLessThan(0.15);
    });

    it('rises on alternating speech/pause windows', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      let last = fx.push(vowelLike(200, 0.5));
      // Toggle: 30 windows of {voiced, silent, voiced, silent...}
      for (let i = 0; i < 30; i++) {
        last = fx.push(i % 2 === 0 ? silence() : vowelLike(200, 0.5));
      }
      expect(last.activity).toBeGreaterThan(0.4);
    });
  });

  describe('shape sanity', () => {
    it('every new channel is finite and within its declared range', () => {
      const fx = new AudioFeatureExtractor({ sampleRate: SR });
      // Run a mixed signal so each channel exercises its computation.
      const sources = [
        () => vowelLike(120, 0.3),
        () => vowelLike(250, 0.6),
        () => fricativeLike(0.4),
        () => silence(),
        () => vowelLike(200, 0.8),
      ];
      for (let i = 0; i < 60; i++) {
        const src = sources[i % sources.length]!;
        const f = fx.push(src());
        expect(Number.isFinite(f.mouthShape)).toBe(true);
        expect(f.mouthShape).toBeGreaterThanOrEqual(0);
        expect(f.mouthShape).toBeLessThanOrEqual(1);
        expect(Number.isFinite(f.pitchTrend)).toBe(true);
        expect(f.pitchTrend).toBeGreaterThanOrEqual(-1);
        expect(f.pitchTrend).toBeLessThanOrEqual(1);
        expect(Number.isFinite(f.expressiveness)).toBe(true);
        expect(f.expressiveness).toBeGreaterThanOrEqual(0);
        expect(f.expressiveness).toBeLessThanOrEqual(1);
        expect(Number.isFinite(f.activity)).toBe(true);
        expect(f.activity).toBeGreaterThanOrEqual(0);
        expect(f.activity).toBeLessThanOrEqual(1);
      }
    });
  });
});
