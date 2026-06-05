/**
 * Tier-1: drive a clip through the REAL production feature pipeline and
 * capture the exact per-frame animation parameters that would hit the wire.
 *
 * This imports the production classes unchanged — `extractRawFeatures` →
 * `AudioFeatureExtractor.pushRawFeatures` → `AcousticEventDetector.push` —
 * and assembles the same object `feature-event-listener.ts` ships via
 * `orchestrator.sendAnimationFrame` (minus the wire `seq`). So a high score
 * here means the production pipeline genuinely produces emotion-distinct,
 * lively parameters; a low score means it can't, no matter how good the
 * marks are.
 */
import {
  extractRawFeatures,
  AudioFeatureExtractor,
  FEATURE_WINDOW_MS,
  type AcousticEvent,
} from '../../../calls/audio-feature-extractor.js';
import { AcousticEventDetector } from '../../../calls/acoustic-event-detector.js';

/** One frame of the animation-parameter trajectory (the wire payload sans seq). */
export interface PoseFrame {
  amplitude: number; // = NormalizedFeatures.loudness (see feature-event-listener.ts)
  pitchNorm: number;
  zcrNorm: number;
  mouthShape: number;
  pitchTrend: number;
  expressiveness: number;
  activity: number;
  event: AcousticEvent;
}

/**
 * Stream `samples` through the pipeline in 33 ms windows, mirroring the
 * native FeatureWindow cadence, and return the frame trajectory.
 */
export function runPipeline(samples: Float32Array, sampleRate: number): PoseFrame[] {
  const win = Math.round((sampleRate * FEATURE_WINDOW_MS) / 1000);
  const extractor = new AudioFeatureExtractor({ sampleRate });
  const detector = new AcousticEventDetector();
  const frames: PoseFrame[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    const window = samples.subarray(i, i + win);
    const raw = extractRawFeatures(window, sampleRate);
    const f = extractor.pushRawFeatures(raw);
    const event = detector.push(f, extractor.isCalibrated);
    frames.push({
      amplitude: f.loudness,
      pitchNorm: f.pitchNorm,
      zcrNorm: f.zcrNorm,
      mouthShape: f.mouthShape,
      pitchTrend: f.pitchTrend,
      expressiveness: f.expressiveness,
      activity: f.activity,
      event,
    });
  }
  return frames;
}

export const POSE_CHANNELS = [
  'amplitude',
  'pitchNorm',
  'zcrNorm',
  'mouthShape',
  'pitchTrend',
  'expressiveness',
  'activity',
] as const;
export type PoseChannel = (typeof POSE_CHANNELS)[number];
