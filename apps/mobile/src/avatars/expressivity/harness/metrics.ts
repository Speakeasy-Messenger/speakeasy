/**
 * Tier-1 metrics over the animation-parameter trajectories.
 *
 * Three families, each answering a concrete question:
 *  - DISCRIMINABILITY: are the parameters emotion-distinct enough that a
 *    trivial classifier can recover the label? (Leave-one-out nearest-
 *    centroid over per-clip summary vectors → accuracy + confusion.) If the
 *    pipeline can't separate laugh from neutral, no mark can either.
 *  - SIGNATURES: per label, did the EXPECTED channel actually light up?
 *    (Interpretable 0–1 ground-truth checks: laugh→event fires, yell→loud,
 *    question→pitch rises, sad→pitch falls, excited→expressive, …)
 *  - LIVELINESS / DEAD CHANNELS: which channels carry temporal signal vs sit
 *    flat — the dormant channels (zcrNorm/pitchNorm today) the marks should
 *    start consuming.
 *
 * All pure numeric functions; no rendering, no native deps.
 */
import { POSE_CHANNELS, type PoseChannel, type PoseFrame } from './run-pipeline.js';
import type { EmotionLabel } from '../corpus/index.js';
import { EMOTION_LABELS } from '../corpus/index.js';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = clamp01(p) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

// ── Summary feature vector (one per clip) ──────────────────────────────────

const SUMMARY_KEYS = [
  'ampP50',
  'ampP90',
  'sustainedLoud',
  'voicedFrac',
  'pitchMean',
  'mouthP90',
  'exprMean',
  'exprMax',
  'actMean',
  'actMax',
  'trendMean',
  'trendEnd',
  'trendMax',
  'trendMin',
  'laughRate',
  'sighRate',
  'gaspRate',
  'hmmRate',
] as const;
type SummaryKey = (typeof SUMMARY_KEYS)[number];
export type Summary = Record<SummaryKey, number>;

export function summarize(frames: PoseFrame[]): Summary {
  const amp = frames.map((f) => f.amplitude);
  const expr = frames.map((f) => f.expressiveness);
  const act = frames.map((f) => f.activity);
  const trend = frames.map((f) => f.pitchTrend);
  const voiced = frames.filter((f) => f.pitchNorm > 0.05);
  const lastQuarter = frames.slice(Math.floor(frames.length * 0.75));
  const rate = (e: string) => frames.filter((f) => f.event === e).length / Math.max(1, frames.length);
  return {
    ampP50: pct(amp, 0.5),
    ampP90: pct(amp, 0.9),
    sustainedLoud: frames.filter((f) => f.amplitude > 0.6).length / Math.max(1, frames.length),
    voicedFrac: voiced.length / Math.max(1, frames.length),
    pitchMean: mean(voiced.map((f) => f.pitchNorm)),
    mouthP90: pct(frames.map((f) => f.mouthShape), 0.9),
    exprMean: mean(expr),
    exprMax: Math.max(0, ...expr),
    actMean: mean(act),
    actMax: Math.max(0, ...act),
    trendMean: mean(trend),
    trendEnd: mean(lastQuarter.map((f) => f.pitchTrend)),
    trendMax: Math.max(0, ...trend),
    trendMin: Math.min(0, ...trend),
    laughRate: rate('laugh'),
    sighRate: rate('sigh'),
    gaspRate: rate('gasp'),
    hmmRate: rate('hmm'),
  };
}

// ── Discriminability (leave-one-out nearest centroid) ──────────────────────

export interface Discriminability {
  accuracy: number;
  /** confusion[actual][predicted] = count. */
  confusion: Record<string, Record<string, number>>;
  perClassRecall: Record<string, number>;
}

function zNormalize(vectors: Summary[]): number[][] {
  const cols = SUMMARY_KEYS.map((k) => vectors.map((v) => v[k]));
  const stats = cols.map((c) => ({ m: mean(c), s: std(c) || 1 }));
  return vectors.map((v) =>
    SUMMARY_KEYS.map((k, j) => (v[k] - stats[j]!.m) / stats[j]!.s),
  );
}

function dist2(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i]! - b[i]!) ** 2;
  return d;
}

export function discriminability(
  labels: EmotionLabel[],
  summaries: Summary[],
): Discriminability {
  const X = zNormalize(summaries);
  const present = EMOTION_LABELS.filter((l) => labels.includes(l));
  const confusion: Record<string, Record<string, number>> = {};
  for (const a of present) confusion[a] = Object.fromEntries(present.map((b) => [b, 0]));
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    // Centroid of each label EXCLUDING clip i (leave-one-out).
    let best: EmotionLabel | undefined;
    let bestD = Infinity;
    for (const lab of present) {
      const members = X.filter((_, j) => j !== i && labels[j] === lab);
      if (!members.length) continue;
      const centroid = members[0]!.map((_, d) => mean(members.map((m) => m[d]!)));
      const dd = dist2(X[i]!, centroid);
      if (dd < bestD) {
        bestD = dd;
        best = lab;
      }
    }
    if (best) {
      confusion[labels[i]!]![best]! += 1;
      if (best === labels[i]) correct++;
    }
  }
  const perClassRecall: Record<string, number> = {};
  for (const a of present) {
    const row = confusion[a]!;
    const total = present.reduce((n, b) => n + row[b]!, 0);
    perClassRecall[a] = total ? row[a]! / total : 0;
  }
  return { accuracy: X.length ? correct / X.length : 0, confusion, perClassRecall };
}

// ── Per-label signature checks (interpretable ground truth) ────────────────

export type Signatures = Partial<Record<EmotionLabel, number>> & { mean: number };

function signatureFor(label: EmotionLabel, s: Summary): number {
  switch (label) {
    case 'laugh':
      return 0.5 * (s.laughRate > 0 ? 1 : 0) + 0.5 * clamp01(s.actMean / 0.4);
    case 'yell':
      return 0.5 * clamp01(s.ampP90 / 0.7) + 0.5 * clamp01(s.sustainedLoud / 0.5);
    case 'question':
      return clamp01(s.trendEnd / 0.3);
    case 'sad':
      return 0.6 * clamp01(-s.trendMean / 0.25) + 0.4 * (s.sighRate > 0 ? 1 : clamp01(1 - s.ampP50 / 0.4));
    case 'excited':
      return clamp01(s.exprMean / 0.45);
    case 'neutral':
      // Moderate everything, no events, little trend.
      return (
        clamp01(1 - s.exprMean / 0.4) *
        clamp01(1 - s.actMean / 0.4) *
        clamp01(1 - Math.abs(s.trendMean) / 0.3) *
        (s.laughRate + s.gaspRate + s.sighRate + s.hmmRate > 0 ? 0.5 : 1) *
        clamp01(s.voicedFrac / 0.6)
      );
    case 'quiet-filler':
      return clamp01(1 - s.ampP50 / 0.15);
    default:
      return 0;
  }
}

export function signatures(labels: EmotionLabel[], summaries: Summary[]): Signatures {
  const byLabel: Partial<Record<EmotionLabel, number[]>> = {};
  labels.forEach((lab, i) => {
    (byLabel[lab] ??= []).push(signatureFor(lab, summaries[i]!));
  });
  const out: Signatures = { mean: 0 };
  const perLabel: number[] = [];
  for (const lab of EMOTION_LABELS) {
    if (byLabel[lab]) {
      out[lab] = mean(byLabel[lab]!);
      perLabel.push(out[lab]!);
    }
  }
  out.mean = mean(perLabel);
  return out;
}

// ── Liveliness / dead channels ─────────────────────────────────────────────

export interface Liveliness {
  /** Mean within-clip temporal std per channel (how much the channel moves). */
  perChannelStd: Record<PoseChannel, number>;
  /** Channels whose motion is below DEAD_CHANNEL_STD across the whole corpus. */
  deadChannels: PoseChannel[];
  /** Fraction of channels that are alive. */
  coverage: number;
}

const DEAD_CHANNEL_STD = 0.02;

export function liveliness(framesByClip: PoseFrame[][]): Liveliness {
  const perChannelStd = {} as Record<PoseChannel, number>;
  for (const ch of POSE_CHANNELS) {
    const perClip = framesByClip.map((frames) =>
      std(frames.map((f) => f[ch] as number)),
    );
    perChannelStd[ch] = mean(perClip);
  }
  const deadChannels = POSE_CHANNELS.filter((ch) => perChannelStd[ch] < DEAD_CHANNEL_STD);
  return {
    perChannelStd,
    deadChannels,
    coverage: (POSE_CHANNELS.length - deadChannels.length) / POSE_CHANNELS.length,
  };
}

// ── Top-level scorecard ────────────────────────────────────────────────────

export interface PipelineScorecard {
  overall: number;
  discriminability: Discriminability;
  signatures: Signatures;
  liveliness: Liveliness;
  meta: { numClips: number; labels: EmotionLabel[] };
}

export function buildScorecardFromFrames(
  corpus: { clipId: string; label: EmotionLabel }[],
  framesByClip: PoseFrame[][],
): PipelineScorecard {
  const labels = corpus.map((c) => c.label);
  const summaries = framesByClip.map(summarize);
  const disc = discriminability(labels, summaries);
  const sig = signatures(labels, summaries);
  const live = liveliness(framesByClip);
  // Weighted headline: discriminability is the spine, signatures confirm the
  // RIGHT channels, liveliness guards against flat output. Tier-2 (rendered
  // face) is the real gate; this is the cheap deterministic guide.
  const overall = 0.5 * disc.accuracy + 0.35 * sig.mean + 0.15 * live.coverage;
  return {
    overall,
    discriminability: disc,
    signatures: sig,
    liveliness: live,
    meta: { numClips: corpus.length, labels: [...new Set(labels)] as EmotionLabel[] },
  };
}
