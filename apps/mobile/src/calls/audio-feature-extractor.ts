/**
 * Phase 5j Private Call — on-device audio feature extraction for the
 * peer-avatar emotion driver. Pure JS; no native deps; ~5–10 ms per
 * 33 ms window (autocorrelation on the speech-pitch lag range is cheap
 * on modern phone CPUs).
 *
 * Three signals at the locked 30 Hz update rate (matching the existing
 * mouth-amplitude pipeline, see `webrtc-peer.ts onAudioLevels`):
 *
 *  1. `loudness` — RMS in [0,1]. The same value the existing
 *     `AudioLevelMeter` polls from `pc.getStats()`; recomputed here
 *     from raw PCM samples so the feature extractor can run upstream
 *     of WebRTC stats (the actual hookup will be the native filter
 *     shim's per-chunk callback when that lands).
 *  2. `pitchNorm` — F0 (fundamental frequency) via autocorrelation,
 *     mapped from the typical speaking-voice range 80–400 Hz into
 *     [0,1]. NaN-safe: silence / noise / unvoiced segments return 0.
 *  3. `zcrNorm` — zero-crossing rate, normalized against the per-call
 *     baseline calibrated from the first ~500 ms of speech. Speech
 *     ZCR varies wildly by speaker and language, so absolute thresholds
 *     are useless; relative-to-self gives a stable signal.
 *
 * Each signal is smoothed through an attack/release follower (~80 ms
 * attack / ~200 ms release — same time constants as the existing
 * AudioLevelMeter) so the emotion state machine downstream sees the
 * envelope, not the per-window flicker.
 *
 * See `lunchbox-main-design-20260524-014323.md` — "Avatar emotion
 * tracking (v1 scope) — feature-extraction, no model" and
 * /plan-design-review D8 (hysteresis on the emotion mapping).
 */

const MIN_SPEECH_F0_HZ = 80;
const MAX_SPEECH_F0_HZ = 400;
/** Window size in ms used for feature extraction; matches the existing
 *  RMS poll cadence (~30 Hz). Caller is responsible for chunking the
 *  raw PCM into windows of this size. */
export const FEATURE_WINDOW_MS = 33;

/** Attack/release follower time constants (locked — same as the
 *  AudioLevelMeter follower so the emotion signals smooth with the
 *  same envelope as the existing mouth-amplitude pipeline). */
const FOLLOWER_ATTACK_MS = 80;
const FOLLOWER_RELEASE_MS = 200;

/** ZCR baseline calibration window — first 500 ms of accumulated
 *  chunks are averaged to establish the per-call baseline. */
const ZCR_CALIBRATION_WINDOWS = Math.ceil(500 / FEATURE_WINDOW_MS);

export interface RawFeatures {
  /** RMS in [0, 1] — instantaneous loudness over this window. */
  loudness: number;
  /** F0 estimate in Hz; 0 when pitch couldn't be determined
   *  (silence, noise, unvoiced segments). */
  pitchHz: number;
  /** Zero-crossing rate per sample in [0, 0.5]. */
  zcr: number;
}

export interface NormalizedFeatures {
  /** [0, 1] — smoothed loudness. */
  loudness: number;
  /**
   * [0, 1] — F0 mapped linearly from the speech range 80–400 Hz,
   * clamped at the edges. Smoothed. 0 when no pitch was detected
   * (the follower decays toward 0 during unvoiced segments rather
   * than holding the last detected pitch — silence is silence).
   */
  pitchNorm: number;
  /**
   * [0, 1] — ZCR scaled against the per-call baseline. Baseline =
   * 0.5; values above are "more sibilant / noisier than usual,"
   * below are "more vowel-like / smoother." Defaults to 0.5 during
   * the calibration window (no signal). Smoothed.
   */
  zcrNorm: number;
}

/**
 * Compute raw features from a single window of PCM samples. Pure
 * function — no calibration, no smoothing. Useful for unit tests and
 * for callers that want to apply their own envelope.
 */
export function extractRawFeatures(
  samples: Float32Array,
  sampleRate: number,
): RawFeatures {
  if (samples.length === 0) {
    return { loudness: 0, pitchHz: 0, zcr: 0 };
  }
  return {
    loudness: computeRms(samples),
    pitchHz: estimatePitchHz(samples, sampleRate),
    zcr: computeZcr(samples),
  };
}

/**
 * Stateful extractor that holds the per-call ZCR baseline and smooths
 * each signal through an attack/release follower. Push one window of
 * PCM at a time; receive the smoothed, normalized features back.
 *
 * Not thread-safe. One instance per call (per direction if the
 * receiver-side ever needs its own — for v1 the sender does the
 * extraction and broadcasts results over the data channel).
 */
export class AudioFeatureExtractor {
  private readonly sampleRate: number;
  private readonly loudnessFollower = new Follower(
    FOLLOWER_ATTACK_MS,
    FOLLOWER_RELEASE_MS,
    FEATURE_WINDOW_MS,
  );
  private readonly pitchNormFollower = new Follower(
    FOLLOWER_ATTACK_MS,
    FOLLOWER_RELEASE_MS,
    FEATURE_WINDOW_MS,
  );
  private readonly zcrNormFollower = new Follower(
    FOLLOWER_ATTACK_MS,
    FOLLOWER_RELEASE_MS,
    FEATURE_WINDOW_MS,
  );
  /** Rolling sum of ZCR readings during the calibration window. */
  private zcrCalibSum = 0;
  /** How many windows have contributed to the baseline so far. */
  private zcrCalibCount = 0;
  /** Established baseline once calibration completes; undefined until then. */
  private zcrBaseline: number | undefined;

  constructor(opts: { sampleRate?: number } = {}) {
    this.sampleRate = opts.sampleRate ?? 48_000;
  }

  /**
   * Process one window of PCM samples; return smoothed normalized
   * features. Call at ~30 Hz (one window per FEATURE_WINDOW_MS).
   */
  push(samples: Float32Array): NormalizedFeatures {
    const raw = extractRawFeatures(samples, this.sampleRate);

    // ZCR calibration: accumulate baseline from the first
    // ZCR_CALIBRATION_WINDOWS windows of audible signal. Skip silent
    // windows (loudness near zero) so the baseline doesn't drift
    // toward whatever noise floor was present pre-speech.
    if (this.zcrBaseline === undefined && raw.loudness > 0.02) {
      this.zcrCalibSum += raw.zcr;
      this.zcrCalibCount += 1;
      if (this.zcrCalibCount >= ZCR_CALIBRATION_WINDOWS) {
        // Floor the baseline at a small value so a tester whose first
        // 500 ms happens to be pure vowels (very low ZCR) doesn't end
        // up with a divide-by-near-zero normalization.
        this.zcrBaseline = Math.max(
          this.zcrCalibSum / this.zcrCalibCount,
          0.01,
        );
      }
    }

    // Pitch normalization: linear map 80→0, 400→1. Outside the
    // speaking range or undetected pitch → 0 (so the follower decays
    // during silence rather than holding the last note).
    let pitchNormInstant = 0;
    if (raw.pitchHz > 0) {
      const clamped = clamp(raw.pitchHz, MIN_SPEECH_F0_HZ, MAX_SPEECH_F0_HZ);
      pitchNormInstant =
        (clamped - MIN_SPEECH_F0_HZ) / (MAX_SPEECH_F0_HZ - MIN_SPEECH_F0_HZ);
    }

    // ZCR normalization: pre-calibration → return 0.5 (neutral —
    // emotion state machine won't trigger on either side); after
    // calibration → scale so baseline maps to 0.5.
    const zcrNormInstant =
      this.zcrBaseline === undefined
        ? 0.5
        : clamp(raw.zcr / (2 * this.zcrBaseline), 0, 1);

    return {
      loudness: this.loudnessFollower.push(raw.loudness),
      pitchNorm: this.pitchNormFollower.push(pitchNormInstant),
      zcrNorm: this.zcrNormFollower.push(zcrNormInstant),
    };
  }

  /** True once the per-call ZCR baseline has been established. */
  get isCalibrated(): boolean {
    return this.zcrBaseline !== undefined;
  }

  /** Test-only inspection of the baseline value. */
  get _zcrBaseline(): number | undefined {
    return this.zcrBaseline;
  }
}

// ---------- internals ----------

function computeRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

function computeZcr(samples: Float32Array): number {
  let crossings = 0;
  let prev = samples[0] ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i] ?? 0;
    // Strict-sign check: we count + → − or − → + crossings, ignoring
    // exact zeros (a sample of 0 between two negatives is not a
    // crossing). This matches the textbook ZCR definition used in
    // the speech literature.
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crossings++;
    prev = cur;
  }
  return crossings / samples.length;
}

/**
 * F0 estimation via autocorrelation. Searches the lag range that
 * corresponds to MIN_SPEECH_F0_HZ … MAX_SPEECH_F0_HZ; returns the
 * frequency at the strongest autocorrelation peak above a noise
 * floor, or 0 if no clear peak exists.
 *
 * Not the most accurate pitch detector — YIN or CMNDF would give
 * cleaner results — but cheap (O(window × lagRange)), runs in
 * single-digit ms per window on phone CPUs, and the downstream
 * normalization+smoothing+follower removes the noise. Good enough
 * for an emotion signal that's already smoothed at 80/200 ms.
 */
function estimatePitchHz(
  samples: Float32Array,
  sampleRate: number,
): number {
  const n = samples.length;
  if (n < 32) return 0;
  const minLag = Math.floor(sampleRate / MAX_SPEECH_F0_HZ);
  const maxLag = Math.floor(sampleRate / MIN_SPEECH_F0_HZ);
  if (maxLag >= n) return 0;

  // Reject low-energy windows — autocorrelation on near-silence
  // produces spurious peaks from numerical noise.
  const rms = computeRms(samples);
  if (rms < 0.02) return 0;

  // Compute normalized autocorrelation for every lag in the search
  // range first, then pick the FIRST local maximum above a strong
  // threshold. This avoids two failure modes of "pick the global
  // max" autocorrelation:
  //   - Pure sines have ties at every integer-period multiple; the
  //     global max picks an arbitrary one (often the wrong one due
  //     to floating-point drift).
  //   - Real speech has near-equal peaks at the fundamental and the
  //     octave; the global max can pick the octave-up (period halved).
  // First-peak-above-threshold biases reliably toward the lowest
  // frequency with a real periodic signal — which for an autocorrelation
  // sweep starting from minLag means the highest pitch with a real
  // peak. For pure sines this is the fundamental; for speech the
  // dominant period is also typically the fundamental.
  const norms = new Float32Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let energyA = 0;
    let energyB = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) {
      const a = samples[i] ?? 0;
      const b = samples[i + lag] ?? 0;
      corr += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denom = Math.sqrt(energyA * energyB);
    norms[lag - minLag] = denom === 0 ? 0 : corr / denom;
  }
  // Voiced threshold — clear `0.85` (≈ "this lag explains 85% of
  // the variance"). Below that the signal isn't periodic enough to
  // call. Empirical; matches the "voiced fricative" cutoff used in
  // the literature for first-pass pitch detection.
  const VOICED_THRESHOLD = 0.85;
  let bestLag = -1;
  // Find the first LOCAL maximum above threshold, scanning from
  // minLag upward (= highest pitch downward — picks the fundamental
  // before its subharmonics). Treat the boundaries explicitly: a
  // peak right at minLag (e.g., 400 Hz at 48 kHz lag = 120, which
  // IS minLag) must be eligible, and the upper boundary at maxLag
  // similarly.
  for (let i = 0; i < norms.length; i++) {
    const cur = norms[i] ?? 0;
    if (cur < VOICED_THRESHOLD) continue;
    const prev = i > 0 ? (norms[i - 1] ?? 0) : -Infinity;
    const next = i < norms.length - 1 ? (norms[i + 1] ?? 0) : -Infinity;
    if (cur >= prev && cur >= next) {
      bestLag = i + minLag;
      break;
    }
  }
  if (bestLag < 0) return 0;
  return sampleRate / bestLag;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Asymmetric one-pole follower. Tracks the input signal with a fast
 * attack and slower release — the same envelope the existing
 * AudioLevelMeter uses, so the emotion-driven `eyeScale` and
 * `amplitude` parameters smooth into the same rhythm as the mouth.
 */
class Follower {
  private state = 0;
  constructor(
    private readonly attackMs: number,
    private readonly releaseMs: number,
    private readonly windowMs: number,
  ) {}

  push(value: number): number {
    const tau = value > this.state ? this.attackMs : this.releaseMs;
    // Exponential one-pole step: alpha = 1 - exp(-Δt/τ).
    const alpha = 1 - Math.exp(-this.windowMs / tau);
    this.state += alpha * (value - this.state);
    return this.state;
  }

  /** Test-only state snapshot. */
  get _state(): number {
    return this.state;
  }
}
