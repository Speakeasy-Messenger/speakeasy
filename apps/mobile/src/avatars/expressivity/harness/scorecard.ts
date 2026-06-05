/**
 * Tier-1 entry point: load the corpus, run every clip through the real
 * pipeline, and build the parameter scorecard. Returns the frames too so
 * Tier-2 can pull representative poses (laugh-peak, yell-peak, …) without
 * re-running the pipeline.
 */
import { loadCorpus, type Clip, type EmotionLabel } from '../corpus/index.js';
import { runPipeline, type PoseFrame } from './run-pipeline.js';
import { buildScorecardFromFrames, type PipelineScorecard } from './metrics.js';
import { runTier2, type Tier2Scorecard } from './tier2.js';

export interface Tier1Result {
  corpus: Clip[];
  framesByClip: PoseFrame[][];
  scorecard: PipelineScorecard;
}

export function runTier1(corpus: Clip[] = loadCorpus()): Tier1Result {
  const framesByClip = corpus.map((c) => runPipeline(c.samples, c.sampleRate));
  const scorecard = buildScorecardFromFrames(
    corpus.map((c) => ({ clipId: c.clipId, label: c.label })),
    framesByClip,
  );
  return { corpus, framesByClip, scorecard };
}

/**
 * Headline split between the two tiers. The user judges the *face*, so
 * Tier-2 (does the rendered avatar actually move the right regions)
 * carries more weight than Tier-1 (does the signal exist). Tier-1 is
 * the guard: a high Tier-2 over a broken signal would be motion driven
 * by noise, so we never let Tier-1 drop silently — the loop gates on
 * both.
 */
export const TIER1_WEIGHT = 0.4;
export const TIER2_WEIGHT = 0.6;

export interface HarnessScorecard {
  /** Combined headline the iteration loop optimizes. */
  overall: number;
  tier1: PipelineScorecard;
  tier2: Tier2Scorecard;
}

/**
 * Full harness pass: signal (Tier-1) + rendered-face coverage
 * (Tier-2). This is the single entry point the iteration-loop driver
 * and the self-test both call.
 */
export function runHarness(): HarnessScorecard {
  const tier1 = runTier1().scorecard;
  const tier2 = runTier2();
  const overall = TIER1_WEIGHT * tier1.overall + TIER2_WEIGHT * tier2.overall;
  return { overall, tier1, tier2 };
}

/**
 * Pick a representative pose per emotion from the corpus trajectories, for
 * Tier-2 rendering. "peak" picks the frame maximizing a per-label channel;
 * neutral/filler take the median frame.
 */
export function representativePoses(result: Tier1Result): Record<string, PoseFrame> {
  const byLabel: Partial<Record<EmotionLabel, PoseFrame[]>> = {};
  result.corpus.forEach((c, i) => {
    (byLabel[c.label] ??= []).push(...result.framesByClip[i]!);
  });
  const argmax = (frames: PoseFrame[], key: (f: PoseFrame) => number): PoseFrame =>
    frames.reduce((best, f) => (key(f) > key(best) ? f : best), frames[0]!);
  const median = (frames: PoseFrame[]): PoseFrame => frames[Math.floor(frames.length / 2)]!;

  const out: Record<string, PoseFrame> = {};
  for (const [label, frames] of Object.entries(byLabel) as [EmotionLabel, PoseFrame[]][]) {
    if (!frames.length) continue;
    switch (label) {
      case 'laugh':
        out[label] = frames.find((f) => f.event === 'laugh') ?? argmax(frames, (f) => f.activity);
        break;
      case 'yell':
        out[label] = argmax(frames, (f) => f.amplitude);
        break;
      case 'question':
        out[label] = argmax(frames, (f) => f.pitchTrend);
        break;
      case 'sad':
        out[label] = argmax(frames, (f) => -f.pitchTrend);
        break;
      case 'excited':
        out[label] = argmax(frames, (f) => f.expressiveness);
        break;
      default:
        out[label] = median(frames);
    }
  }
  return out;
}
