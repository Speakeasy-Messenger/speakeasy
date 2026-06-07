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
 *  hallucinate one mid-sentence).
 *
 *  rc.* recalibration: the original absolute values were set against a
 *  hotter, less-smoothed feature scale than the pipeline actually
 *  ships. Replaying a real 3-minute call through the production
 *  pipeline, every event's binding gate was UNREACHABLE — loudness
 *  jumps capped at 0.26 (vs a 0.4 gate), smoothed pitchTrend at ±0.07
 *  (vs ∓0.3 gates), and the laugh cadence read 0 transitions because
 *  smoothing latches the voiced flag on. Two fixes paired: (1) the
 *  detector now keys laugh/gasp on the transient tap (`loudnessFast` /
 *  `voicedInstant`) so the bursts survive, and (2) the loudness/pitch
 *  gates below are pulled in to the real signal's range. The detector
 *  unit tests (which use exaggerated synthetic deltas) still pass — and
 *  the cooldown still caps firing at ~1 event / 2 s, so a looser gate
 *  can't produce a thrash of overlays. */
// LAUGH — rhythm + breathiness, NOT voiced-transition counting.
//
// The original detector counted voiced↔unvoiced flips and keyed on a
// flip-rate threshold. On real calls that was the worst possible choice
// (rc.78–80 on-device: missed real laughs, fired the squint on speech
// SECONDS after the laugh ended). Two reasons, both confirmed in the
// acoustics literature:
//   • A laugh is largely UNVOICED/breathy — Bachorowski & Owren and
//     others find pitch is detectable in a minority of laugh frames, so
//     a smooth "haaa-haaa" yields FEW flips and is missed.
//   • Choppy conversational speech (short words + gaps) racks up flips
//     and false-fires.
// The robust signature (Provine 2000; modulation-spectrum analyses) is
// the RHYTHM: laugh "notes" are ~75 ms long repeated ~210 ms apart — a
// regular amplitude modulation at ~4.7 Hz. We detect that regularity via
// the normalized autocorrelation of the loudness envelope in a lag band,
// gated by a loud PEAK (laughs are bursty: high peak, low mean) and by
// breathiness (elevated ZCR) OR high pitch when voiced (laugh F0 ≈ 2×
// speech). Offline-validated on synthetic laugh/speech/choppy/silence:
// ~70 %/window recall on laughs, ~0 % false-fire on the rest (vs the old
// rule's 0.2 % / 59 %). Device-tunable via the [event] diag logging.
const LAUGH_MIN_WINDOWS = 18;          // ~0.6 s before the rhythm is measurable
const LAUGH_RHYTHM_LAG_MIN = 4;        // ~8.3 Hz (period 132 ms)
const LAUGH_RHYTHM_LAG_MAX = 8;        // ~4.1 Hz (period 264 ms); ~210 ms ≈ lag 6.4
const LAUGH_MIN_PERIODICITY = 0.28;    // normalized autocorr peak in the lag band
const LAUGH_MIN_PEAK_LOUDNESS = 0.12;  // bursty — gate on PEAK, not mean (transient tap)
const LAUGH_MIN_ZCR = 0.52;            // breathy: above the per-call ZCR baseline (0.5)
const LAUGH_MIN_PITCH = 0.6;           // high F0 when voiced (≈ 2× speaking pitch)
// SUSTAIN — the precision lever (rc.82). rc.81 fired reliably on laughs
// but also on speech, because a single window of conversational speech
// can momentarily look rhythmic. A real laugh HOLDS its rhythm across
// many notes (≥1 s); a speech coincidence doesn't. Require the full
// laugh condition to hold for this many CONSECUTIVE windows before
// firing. ~0.27 s of sustained rhythm — long enough to reject transient
// speech matches, short enough that the squint still lands during the
// laugh. Cuts false positives without sacrificing the recall rc.81 won.
const LAUGH_SUSTAIN_WINDOWS = 8;
const SIGH_MIN_DURATION_WINDOWS = 12;   // ≥ 400 ms sustained
const SIGH_PITCH_TREND_THRESHOLD = -0.15; // just past the ±0.12 trend deadband
const SIGH_MIN_PRE_SILENCE_WINDOWS = 6; // ≥ 200 ms quiet before
const GASP_LOUDNESS_JUMP = 0.2;         // 2-window delta on the transient (raw) loudness
const GASP_PITCH_TREND_THRESHOLD = 0.3;
const HMM_MIN_DURATION_WINDOWS = 12;    // ≥ 400 ms sustained
const HMM_MAX_ZCR = 0.4;                  // closed-mouth (low fricative content)
const HMM_MIN_LOUDNESS = 0.1;            // audible
const HMM_MAX_PITCH_VARIANCE = 0.15;     // sustained note, not phonemic speech

interface HistoryEntry {
  loudness: number;
  /** Transient (pre-smoothing) loudness — what laugh/gasp inspect.
   *  Falls back to `loudness` when the producer didn't supply it. */
  loudnessFast: number;
  pitchNorm: number;
  zcrNorm: number;
  voiced: boolean; // raw instantaneous voicedness when available, else smoothed shorthand
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
  /** Most recent laugh-feature snapshot (peak loudness, envelope
   *  periodicity, mean ZCR, mean voiced pitch). Surfaced via
   *  `laughStats` for the [event] diag logging so the laugh thresholds
   *  can be tuned against real device captures rather than guessed. */
  private lastLaughStats:
    | { peak: number; periodicity: number; avgZcr: number; avgVoicedPitch: number }
    | undefined;
  /** Consecutive windows the full laugh condition has held — the sustain
   *  counter that rejects momentary speech rhythms (see
   *  LAUGH_SUSTAIN_WINDOWS). Reset whenever the condition lapses. */
  private laughRunLength = 0;

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
    // Prefer the transient tap (raw loudness + raw voicedness) when the
    // producer supplies it: smoothing erases the laugh cadence and gasp
    // jump these rules detect. Fall back to the smoothed values + the
    // derived voiced shorthand so hand-built features (tests) still work.
    const loudnessFast = features.loudnessFast ?? features.loudness;
    const voiced =
      features.voicedInstant ??
      (features.pitchNorm > 0 && features.loudness > 0.02);
    const entry: HistoryEntry = {
      loudness: features.loudness,
      loudnessFast,
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
    this.lastLaughStats = undefined;
    this.laughRunLength = 0;
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
    // Transient loudness — a gasp's jump is sharp and the follower
    // would smear it below the gate.
    const now = this.history[this.history.length - 1]!.loudnessFast;
    const twoAgo = this.history[this.history.length - 3]!.loudnessFast;
    if (now - twoAgo < GASP_LOUDNESS_JUMP) return undefined;
    if (features.pitchTrend < GASP_PITCH_TREND_THRESHOLD) return undefined;
    // Gasps are short — the `voicedRunLength > 6 && silenceRunLength === 0`
    // guard above already caps the duration (≥ 200 ms of continuous
    // voicedness means "mid-shout", not "gasp from quiet").
    return 'gasp';
  }

  /**
   * Laugh: a regular amplitude-modulation RHYTHM at the laugh-call rate
   * (~210 ms between notes ≈ 4.7 Hz), loud, and breathy or high-pitched.
   * See the LAUGH_* constant block for why this replaced flip-counting.
   *
   * `lastLaughStats` is populated each call for the [event] diag logging
   * so the thresholds can be tuned against real device captures.
   */
  private detectLaugh(): AcousticEvent | undefined {
    const H = this.history;
    if (H.length < LAUGH_MIN_WINDOWS) {
      this.laughRunLength = 0;
      return undefined;
    }

    const amps = H.map((e) => e.loudnessFast);
    // Bursty — a laugh's inter-note gaps drag the MEAN down, so gate on
    // the loud PEAK instead.
    let peak = 0;
    for (const a of amps) if (a > peak) peak = a;

    const periodicity = this.envelopePeriodicity(amps);

    let zcrSum = 0;
    let voicedPitchSum = 0;
    let voicedCount = 0;
    for (const e of H) {
      zcrSum += e.zcrNorm;
      if (e.voiced) {
        voicedPitchSum += e.pitchNorm;
        voicedCount += 1;
      }
    }
    const avgZcr = zcrSum / H.length;
    const avgVoicedPitch = voicedCount > 0 ? voicedPitchSum / voicedCount : 0;
    const highPitched = voicedCount > 0 && avgVoicedPitch > LAUGH_MIN_PITCH;
    const breathy = avgZcr > LAUGH_MIN_ZCR;

    this.lastLaughStats = { peak, periodicity, avgZcr, avgVoicedPitch };

    const conditionMet =
      peak >= LAUGH_MIN_PEAK_LOUDNESS &&
      periodicity >= LAUGH_MIN_PERIODICITY &&
      (breathy || highPitched);
    if (!conditionMet) {
      this.laughRunLength = 0;
      return undefined;
    }
    // Require the rhythm to PERSIST — a real laugh holds it across many
    // notes; a momentary speech coincidence lapses within a window or two.
    this.laughRunLength += 1;
    if (this.laughRunLength < LAUGH_SUSTAIN_WINDOWS) return undefined;
    return 'laugh';
  }

  /**
   * Normalized autocorrelation peak of the (mean-removed) loudness
   * envelope across the laugh-rhythm lag band. ~1.0 = a perfectly
   * regular burst train at that period; ~0 = noise / no rhythm. Speech
   * envelopes are semi-periodic and irregular, so they sit low; a laugh's
   * "ha-ha-ha" lands high. O(windows × lagBand) — a few hundred multiply-
   * adds per frame, negligible.
   */
  private envelopePeriodicity(amps: number[]): number {
    const n = amps.length;
    let mean = 0;
    for (const a of amps) mean += a;
    mean /= n;
    const x = new Array<number>(n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] = amps[i]! - mean;
      energy += x[i]! * x[i]!;
    }
    if (energy < 1e-6) return 0;
    let best = 0;
    for (let lag = LAUGH_RHYTHM_LAG_MIN; lag <= LAUGH_RHYTHM_LAG_MAX; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += x[i]! * x[i - lag]!;
      const r = s / energy;
      if (r > best) best = r;
    }
    return best;
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

  /** Latest laugh-feature snapshot for diagnostics/tuning. Undefined
   *  until the first window where the laugh detector ran (i.e. enough
   *  history + not in cooldown). */
  get laughStats():
    | { peak: number; periodicity: number; avgZcr: number; avgVoicedPitch: number }
    | undefined {
    return this.lastLaughStats;
  }
}
