/**
 * Corpus provider. Returns the labeled clips the harness scores.
 *
 * For now this is the synthetic bootstrap set so the harness is buildable
 * + self-testable end-to-end. When real recorded fixtures land
 * (corpus/manifest.json + per-clip Float32 data, written by
 * tools/ingest-clip.ts), this swaps to those — the harness code above it
 * doesn't change.
 */
import { synthCorpus, type Clip, type EmotionLabel } from './synth.js';

export function loadCorpus(): Clip[] {
  // Real fixtures take precedence once present; until then, bootstrap synth.
  // (Fixture loading is wired in Phase 5 — see tools/ingest-clip.ts.)
  return synthCorpus();
}

export type { Clip, EmotionLabel };
export { EMOTION_LABELS } from './synth.js';
