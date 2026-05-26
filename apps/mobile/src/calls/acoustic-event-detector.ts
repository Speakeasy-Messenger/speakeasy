/**
 * Phase 5j Private Call — heuristic acoustic-event detector.
 *
 * Continuous channels (mouthShape / pitchTrend / expressiveness /
 * activity) drive the avatar's steady-state motion. This detector
 * fires on the *dramatic beats* — laughs, sighs, gasps, "hmm"s —
 * the moments where humans most want expression confirmation. The
 * receiver maps each event to a one-shot pose overlay (~1.5 s) on
 * top of the continuous animation.
 *
 * Detection is **rule-based heuristic** for v1 (rc.11). The events
 * have distinctive enough acoustic signatures that simple
 * feature-time-series rules catch the obvious cases with acceptable
 * recall + precision. The wire format is decoupled (`AcousticEvent`
 * lives in `audio-feature-extractor.ts`) so a future on-device
 * classifier can fill the same enum without protocol churn.
 *
 * Tradeoff committed to: heuristics will miss subtle laughs and
 * occasionally fire on chains of short utterances. The user-visible
 * floor is "the avatar mostly gets it right; the misses don't feel
 * broken, just quiet." A 70 % accurate classifier later would lift
 * the ceiling significantly.
 *
 * Each event has a cooldown (~2 s) so a sustained laugh doesn't
 * fire 30 events per second — the receiver's overlay would just
 * thrash. One event per dramatic beat is the right cadence.
 */

import type {
  AcousticEvent,
  NormalizedFeatures,
} from './audio-feature-extractor.js';

/** How long to suppress new event firings after a successful detection,
 *  in feature windows. 60 windows × 33 ms ≈ 2 s — long enough that a
 *  sustained laugh produces ~1 event/2 s instead of 30. */
const COOLDOWN_WINDOWS = 60;

/** Trailing-window length for inspecting feature time-series. 30
 *  windows ≈ 1 s — one prosodic phrase. */
const HISTORY_WINDOWS = 30;

/** Detection thresholds for each event class. Tuned empirically;
 *  conservative on precision (better to miss a laugh than to
 *  hallucinate one mid-sentence). */
const LAUGH_MIN_VOICED_TRANSITIONS = 5; // ≥ 5 voicedness flips in 1 s = giggle cadence
const LAUGH_MIN_AMPLITUDE = 0.25;       // not a whisper
const SIGH_MIN_DURATION_WINDOWS = 12;   // ≥ 400 ms sustained
const SIGH_PITCH_TREND_THRESHOLD = -0.3;
const SIGH_MIN_PRE_SILENCE_WINDOWS = 6; // ≥ 200 ms quiet before
const GASP_LOUDNESS_JUMP = 0.4;         // 2-window amplitude delta
const GASP_PITCH_TREND_THRESHOLD = 0.3;
const HMM_MIN_DURATION_WINDOWS = 12;    // ≥ 400 ms sustained
const HMM_MAX_ZCR = 0.35;                // closed-mouth (low fricative content)
const HMM_MIN_LOUDNESS = 0.1;            // audible
const HMM_MAX_PITCH_VARIANCE = 0.15;     // sustained note, not phonemic speech

interface HistoryEntry {
  loudness: number;
  pitchNorm: number;
  zcrNorm: number;
  voiced: boolean; // shorthand: pitchNorm > 0 AND loudness > gate
}

export class AcousticEventDetector {
  private readonly history: HistoryEntry[] = [];
  /** Windows of contiguous voiced material at the head of the
   *  current run. Reset on a transition to unvoiced. */
  private voicedRunLength = 0;
  /** Windows of contiguous unvoiced material at the head of the
   *  current run. Reset on a transition to voiced. */
  private silenceRunLength = 0;
  /** Cooldown counter in windows. While > 0, all event detection
   *  short-circuits to 'none'. Decremented each push(). */
  private cooldownWindows = 0;

  /**
   * Consume one window of smoothed normalized features and return
   * the event (if any) detected at this moment. 'none' on most
   * frames — events are rare by nature.
   *
   * `featuresReady` should reflect the upstream extractor's
   * calibration state — when false, the detector accumulates
   * history but won't fire any event. This stops the call-start
   * gap where the extractor returns `zcrNorm = 0.5` as a
   * pre-calibration placeholder; once calibration completes, the
   * scaling can swing the value below `HMM_MAX_ZCR` mid-utterance
   * and look indistinguishable from a real hum to the detector.
   * Callers pass `extractor.isCalibrated` here.
   *
   * Call at the same 30 Hz cadence as `AudioFeatureExtractor.push`.
   */
  push(features: NormalizedFeatures, featuresReady = true): AcousticEvent {
    const voiced = features.pitchNorm > 0 && features.loudness > 0.02;
    const entry: HistoryEntry = {
      loudness: features.loudness,
      pitchNorm: features.pitchNorm,
      zcrNorm: features.zcrNorm,
      voiced,
    };
    this.history.push(entry);
    if (this.history.length > HISTORY_WINDOWS) this.history.shift();

    // Update contiguous-run trackers.
    if (voiced) {
      this.voicedRunLength += 1;
      this.silenceRunLength = 0;
    } else {
      this.silenceRunLength += 1;
      this.voicedRunLength = 0;
    }

    // Respect cooldown — one event per dramatic beat.
    if (this.cooldownWindows > 0) {
      this.cooldownWindows -= 1;
      return 'none';
    }

    // Don't fire while the extractor is still calibrating — features
    // can swing mid-utterance the moment baselines lock in. Keep
    // accumulating history so the FIRST post-calibration detection
    // sees a fully-populated window.
    if (!featuresReady) return 'none';

    // Try detectors in order of recall — gasp (instant), laugh
    // (rapid pattern), then the sustained ones (sigh / hmm). Each
    // returns 'none' if its preconditions aren't met.
    const detected =
      this.detectGasp(features) ||
      this.detectLaugh() ||
      this.detectSigh(features) ||
      this.detectHmm(features) ||
      'none';

    if (detected !== 'none') {
      this.cooldownWindows = COOLDOWN_WINDOWS;
    }
    return detected;
  }

  /**
   * Reset all internal state — call at the start of a new call so
   * a prior call's history can't trigger a spurious event in the
   * first second of a new one.
   */
  reset(): void {
    this.history.length = 0;
    this.voicedRunLength = 0;
    this.silenceRunLength = 0;
    this.cooldownWindows = 0;
  }

  /**
   * Gasp: a sharp loudness jump + rising pitch over the last few
   * windows, with a recent quiet stretch (so we don't trigger on
   * every emphasized syllable mid-sentence).
   */
  private detectGasp(features: NormalizedFeatures): AcousticEvent | undefined {
    if (this.history.length < 3) return undefined;
    // Require some prior silence — 100 ms or so. A gasp emerges
    // from "I'm quiet" not "I'm mid-sentence."
    if (this.silenceRunLength === 0 && this.voicedRunLength > 6) {
      return undefined;
    }
    const now = this.history[this.history.length - 1]!.loudness;
    const twoAgo = this.history[this.history.length - 3]!.loudness;
    if (now - twoAgo < GASP_LOUDNESS_JUMP) return undefined;
    if (features.pitchTrend < GASP_PITCH_TREND_THRESHOLD) return undefined;
    // Gasps are short — the `voicedRunLength > 6 && silenceRunLength === 0`
    // guard above already caps the duration (≥ 200 ms of continuous
    // voicedness means "mid-shout", not "gasp from quiet").
    return 'gasp';
  }

  /**
   * Laugh: at least N voicedness transitions inside the 1 s
   * history window. Counts both voiced→silent AND silent→voiced
   * flips (a giggle's "ha-ha-ha" produces both). Requires
   * amplitude above whisper-level (laughs are not subtle).
   */
  private detectLaugh(): AcousticEvent | undefined {
    if (this.history.length < HISTORY_WINDOWS / 2) return undefined;
    let transitions = 0;
    let amplitudeSum = 0;
    for (let i = 1; i < this.history.length; i++) {
      const prev = this.history[i - 1]!;
      const cur = this.history[i]!;
      if (prev.voiced !== cur.voiced) transitions += 1;
      amplitudeSum += cur.loudness;
    }
    const avgAmplitude = amplitudeSum / (this.history.length - 1);
    if (transitions < LAUGH_MIN_VOICED_TRANSITIONS) return undefined;
    if (avgAmplitude < LAUGH_MIN_AMPLITUDE) return undefined;
    return 'laugh';
  }

  /**
   * Sigh: a sustained voiced segment (~400 ms+) with descending
   * pitch, preceded by a quiet stretch. Distinguished from "long
   * vowel mid-sentence" by the pre-silence requirement.
   */
  private detectSigh(features: NormalizedFeatures): AcousticEvent | undefined {
    if (this.voicedRunLength < SIGH_MIN_DURATION_WINDOWS) return undefined;
    // Look for the silence stretch that preceded the current voiced run.
    // Walk back from where the voiced run started.
    const voicedStartIdx = this.history.length - this.voicedRunLength;
    if (voicedStartIdx < SIGH_MIN_PRE_SILENCE_WINDOWS) return undefined;
    let preSilence = 0;
    for (
      let i = voicedStartIdx - 1;
      i >= 0 && i >= voicedStartIdx - SIGH_MIN_PRE_SILENCE_WINDOWS;
      i--
    ) {
      if (!this.history[i]!.voiced) preSilence += 1;
      else break;
    }
    if (preSilence < SIGH_MIN_PRE_SILENCE_WINDOWS) return undefined;
    if (features.pitchTrend > SIGH_PITCH_TREND_THRESHOLD) return undefined;
    return 'sigh';
  }

  /**
   * "Hmm": sustained low-pitched voiced segment with low ZCR
   * (closed-mouth resonance) and low pitch variance (it's a held
   * note, not a phrase).
   */
  private detectHmm(features: NormalizedFeatures): AcousticEvent | undefined {
    if (this.voicedRunLength < HMM_MIN_DURATION_WINDOWS) return undefined;
    if (features.zcrNorm > HMM_MAX_ZCR) return undefined;
    if (features.loudness < HMM_MIN_LOUDNESS) return undefined;
    // Pitch must be steady — a slowly-rolling note, not a syllable
    // sequence.
    if (features.expressiveness > HMM_MAX_PITCH_VARIANCE) return undefined;
    return 'hmm';
  }

  /** Test-only inspection of cooldown state. */
  get _cooldownWindows(): number {
    return this.cooldownWindows;
  }
}
