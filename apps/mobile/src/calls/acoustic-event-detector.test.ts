/**
 * Heuristic acoustic-event detector — vitest coverage.
 *
 * These tests synthesize NormalizedFeatures sequences shaped like
 * each event's acoustic signature, push them through the detector,
 * and verify the right event fires (or doesn't, for negative
 * cases). They don't claim the heuristics match production audio
 * with high accuracy — the goal is to keep the rules from regressing
 * silently as we tune them, and to document the EXPECTED shape of
 * each event.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AcousticEventDetector } from './acoustic-event-detector.js';
import type { NormalizedFeatures } from './audio-feature-extractor.js';

/**
 * Build a NormalizedFeatures partial with sensible defaults. The
 * extra fields the detector doesn't currently inspect are set to
 * neutral / zero so the tests focus on what each event uses.
 */
function features(
  partial: Partial<NormalizedFeatures> = {},
): NormalizedFeatures {
  return {
    loudness: 0,
    pitchNorm: 0,
    zcrNorm: 0.5,
    mouthShape: 0,
    pitchTrend: 0,
    expressiveness: 0,
    activity: 0,
    ...partial,
  };
}

const silentWindow = features();
const sustainedVoicedQuiet = features({
  loudness: 0.15,
  pitchNorm: 0.4,
  zcrNorm: 0.25,
  pitchTrend: 0,
  expressiveness: 0.05,
});

describe('AcousticEventDetector — defaults', () => {
  let detector: AcousticEventDetector;
  beforeEach(() => {
    detector = new AcousticEventDetector();
  });

  it('returns "none" for an empty / silent stream', () => {
    for (let i = 0; i < 60; i++) {
      expect(detector.push(silentWindow)).toBe('none');
    }
  });

  it('returns "none" for a steady mid-volume voiced stream (no event)', () => {
    let result = 'none' as string;
    for (let i = 0; i < 30; i++) {
      result = detector.push(
        features({
          loudness: 0.5,
          pitchNorm: 0.5,
          zcrNorm: 0.5,
          pitchTrend: 0,
          expressiveness: 0.1,
        }),
      );
    }
    // Long voiced run with no pre-silence shouldn't trigger sigh.
    // No transitions = not a laugh. ZCR=0.5 = not an hmm. No
    // amplitude jump = not a gasp.
    expect(result).toBe('none');
  });
});

describe('laugh detection (rhythm-based, rc.81)', () => {
  // A laugh window: notes ~75 ms (≈2 windows) repeated every ~210 ms
  // (≈6 windows) — a regular ~4.7 Hz amplitude rhythm — loud, breathy
  // (elevated ZCR), with high pitch on the voiced notes.
  function laughWindow(i: number): NormalizedFeatures {
    const phase = i % 6; // 6-window period ≈ 200 ms
    const onNote = phase < 2; // ~66 ms note
    return features({
      loudness: onNote ? 0.45 : 0.03,
      loudnessFast: onNote ? 0.45 : 0.03,
      pitchNorm: onNote ? 0.8 : 0, // high F0 when voiced
      zcrNorm: onNote ? 0.62 : 0.5, // breathy
      voicedInstant: onNote,
    });
  }

  it('fires on the laugh rhythm — loud, regular ~4.7 Hz bursts, breathy/high-pitched', () => {
    const detector = new AcousticEventDetector();
    let fired = false;
    for (let i = 0; i < 30; i++) {
      if (detector.push(laughWindow(i)) === 'laugh') fired = true;
    }
    expect(fired).toBe(true);
  });

  it('does NOT fire when the rhythm is too quiet (whispered laugh below peak gate)', () => {
    const detector = new AcousticEventDetector();
    let fired = false;
    for (let i = 0; i < 30; i++) {
      const phase = i % 6;
      const onNote = phase < 2;
      const r = detector.push(
        features({
          loudness: onNote ? 0.06 : 0.01,
          loudnessFast: onNote ? 0.06 : 0.01, // below LAUGH_MIN_PEAK_LOUDNESS
          pitchNorm: onNote ? 0.8 : 0,
          zcrNorm: onNote ? 0.62 : 0.5,
          voicedInstant: onNote,
        }),
      );
      if (r === 'laugh') fired = true;
    }
    expect(fired).toBe(false);
  });

  it('does NOT fire on irregular / choppy speech (the old detector false-fired here)', () => {
    const detector = new AcousticEventDetector();
    // Short voiced words with irregular gaps — many voiced transitions
    // (what tripped the old flip-counter) but NO regular rhythm, normal
    // ZCR, mid pitch.
    const lengths = [2, 1, 3, 1, 2, 1, 2, 3, 1, 2];
    let i = 0;
    let fired = false;
    for (let w = 0; w < lengths.length && i < 60; w++) {
      for (let k = 0; k < lengths[w]! && i < 60; k++, i++) {
        if (
          detector.push(
            features({
              loudness: 0.16,
              loudnessFast: 0.16,
              pitchNorm: 0.42,
              zcrNorm: 0.46,
              voicedInstant: true,
            }),
          ) === 'laugh'
        ) {
          fired = true;
        }
      }
      // irregular gap
      const gap = (w % 2) + 1;
      for (let k = 0; k < gap && i < 60; k++, i++) {
        if (
          detector.push(
            features({ loudness: 0.02, loudnessFast: 0.02, voicedInstant: false }),
          ) === 'laugh'
        ) {
          fired = true;
        }
      }
    }
    expect(fired).toBe(false);
  });

  it('respects the cooldown — fires at most once per ~2 s of sustained laughter', () => {
    const detector = new AcousticEventDetector();
    const fires: string[] = [];
    for (let i = 0; i < 120; i++) {
      const result = detector.push(laughWindow(i));
      if (result !== 'none') fires.push(result);
    }
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.length).toBeLessThanOrEqual(2); // ~4 s / 2 s cooldown
    expect(fires.every((e) => e === 'laugh')).toBe(true);
  });
});

describe('sigh detection', () => {
  it('fires after silence + sustained voiced with falling pitch', () => {
    const detector = new AcousticEventDetector();
    // Establish silence (200 ms = 6 windows).
    for (let i = 0; i < 8; i++) detector.push(silentWindow);
    // Sustained voiced segment with falling pitch (400 ms+). The
    // event fires once when the voiced-run length first crosses the
    // sigh threshold, then the cooldown kicks in for ~2 s, so we
    // collect every event observed across the sequence rather than
    // checking only the last frame.
    const events: string[] = [];
    for (let i = 0; i < 15; i++) {
      const result = detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.4,
          zcrNorm: 0.3,
          pitchTrend: -0.6,
        }),
      );
      events.push(result);
    }
    expect(events).toContain('sigh');
  });

  it('does NOT fire when pitch is rising', () => {
    const detector = new AcousticEventDetector();
    for (let i = 0; i < 8; i++) detector.push(silentWindow);
    for (let i = 0; i < 15; i++) {
      const result = detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.5,
          pitchTrend: 0.4,
        }),
      );
      expect(result).not.toBe('sigh');
    }
  });

  it('does NOT fire when there is no pre-silence (mid-sentence vowel)', () => {
    const detector = new AcousticEventDetector();
    // Continuous voicedness from the start, no pre-silence.
    for (let i = 0; i < 20; i++) {
      const result = detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.4,
          pitchTrend: -0.5,
        }),
      );
      expect(result).not.toBe('sigh');
    }
  });
});

describe('gasp detection', () => {
  it('fires on a sharp loudness jump from silence with rising pitch', () => {
    const detector = new AcousticEventDetector();
    // Silence prelude.
    for (let i = 0; i < 5; i++) detector.push(silentWindow);
    // Sudden voicing jump.
    detector.push(features({ loudness: 0.1, pitchNorm: 0.5, pitchTrend: 0.5 }));
    const result = detector.push(
      features({
        loudness: 0.6, // delta > GASP_LOUDNESS_JUMP from 2 windows back
        pitchNorm: 0.7,
        pitchTrend: 0.5,
      }),
    );
    expect(result).toBe('gasp');
  });

  it('does NOT fire mid-conversation (no pre-silence)', () => {
    const detector = new AcousticEventDetector();
    // Long voiced run, then a loudness bump.
    for (let i = 0; i < 20; i++) {
      detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.5,
        }),
      );
    }
    // Even with a big loudness jump, mid-sentence shouldn't trigger.
    const result = detector.push(
      features({
        loudness: 0.8,
        pitchNorm: 0.7,
        pitchTrend: 0.5,
      }),
    );
    expect(result).not.toBe('gasp');
  });
});

describe('hmm detection', () => {
  it('fires on sustained low-ZCR voiced segment with steady pitch', () => {
    const detector = new AcousticEventDetector();
    // 15 windows ≈ 500 ms of closed-mouth resonance. Same
    // cooldown-aware capture pattern as the sigh test.
    const events: string[] = [];
    for (let i = 0; i < 15; i++) {
      const result = detector.push(
        features({
          loudness: 0.2,
          pitchNorm: 0.3,
          zcrNorm: 0.2, // below HMM_MAX_ZCR (0.35)
          expressiveness: 0.05, // monotone
        }),
      );
      events.push(result);
    }
    expect(events).toContain('hmm');
  });

  it('does NOT fire when ZCR is high (open vowel)', () => {
    const detector = new AcousticEventDetector();
    for (let i = 0; i < 15; i++) {
      const result = detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.5,
          zcrNorm: 0.7,
          expressiveness: 0.05,
        }),
      );
      expect(result).not.toBe('hmm');
    }
  });

  it('does NOT fire when pitch is varying (talking, not humming)', () => {
    const detector = new AcousticEventDetector();
    for (let i = 0; i < 15; i++) {
      const result = detector.push(
        features({
          loudness: 0.3,
          pitchNorm: 0.4,
          zcrNorm: 0.2,
          expressiveness: 0.5, // animated → not a hum
        }),
      );
      expect(result).not.toBe('hmm');
    }
  });
});

describe('featuresReady gate', () => {
  it('returns "none" while featuresReady=false even on event-shaped input', () => {
    const detector = new AcousticEventDetector();
    // An hmm-shaped signal: low ZCR, voiced, monotone.
    for (let i = 0; i < 30; i++) {
      const result = detector.push(
        features({
          loudness: 0.2,
          pitchNorm: 0.3,
          zcrNorm: 0.2,
          expressiveness: 0.05,
        }),
        /* featuresReady */ false,
      );
      expect(result).toBe('none');
    }
  });

  it('accumulates history while gated so the first post-ready detection has full context', () => {
    const detector = new AcousticEventDetector();
    // 15 windows while gated — these would normally trigger 'hmm'
    // if the gate were open.
    for (let i = 0; i < 15; i++) {
      detector.push(
        features({
          loudness: 0.2,
          pitchNorm: 0.3,
          zcrNorm: 0.2,
          expressiveness: 0.05,
        }),
        false,
      );
    }
    // First post-ready window: the voicedRunLength built up during
    // gating is still tracked, so detection fires immediately on
    // the next eligible window.
    const fires: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = detector.push(
        features({
          loudness: 0.2,
          pitchNorm: 0.3,
          zcrNorm: 0.2,
          expressiveness: 0.05,
        }),
        true,
      );
      fires.push(result);
    }
    expect(fires).toContain('hmm');
  });
});

describe('reset()', () => {
  it('clears history + cooldown so a new call starts clean', () => {
    const detector = new AcousticEventDetector();
    // Trigger a laugh (regular ~4.7 Hz loud breathy rhythm). Needs enough
    // windows to clear LAUGH_MIN_WINDOWS + LAUGH_SUSTAIN_WINDOWS.
    for (let i = 0; i < 34; i++) {
      const onNote = i % 6 < 2;
      detector.push(
        features({
          loudness: onNote ? 0.45 : 0.03,
          loudnessFast: onNote ? 0.45 : 0.03,
          pitchNorm: onNote ? 0.8 : 0,
          zcrNorm: onNote ? 0.62 : 0.5,
          voicedInstant: onNote,
        }),
      );
    }
    expect(detector._cooldownWindows).toBeGreaterThan(0);
    detector.reset();
    expect(detector._cooldownWindows).toBe(0);
    // After reset, a silent stream produces nothing (no carryover).
    for (let i = 0; i < 10; i++) {
      expect(detector.push(sustainedVoicedQuiet)).toBe('none');
    }
  });
});
