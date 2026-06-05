import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTier1, runHarness, representativePoses } from './harness/scorecard.js';
import { runTier2, EXPRESSION_CHANNELS, FACIAL_REGIONS } from './harness/tier2.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

/**
 * Regression floor for the rendered-face coverage. This is the
 * BASELINE captured when Tier-2 first landed (overall ≈ 0.54). The
 * iteration loop raises faces above this; the committed test only
 * guards that a future edit can't make the avatars LESS expressive
 * than they are today. Bump this floor as the loop ratchets coverage
 * up so gains can't silently regress.
 */
const TIER2_FLOOR = 0.5;

// Tier-1 self-test: the synthetic bootstrap corpus is crude, but it MUST
// exercise the real pipeline and the metrics end-to-end, and the metrics
// must behave sanely (separate emotions above chance, light up the right
// per-label channels, and detect that some channels move). Real recorded
// clips replace the corpus later; these invariants stay.
describe('expressivity Tier-1 pipeline harness', () => {
  const result = runTier1();
  const sc = result.scorecard;

  it('runs every clip through the real pipeline and produces frames', () => {
    expect(result.framesByClip.length).toBe(result.corpus.length);
    for (const frames of result.framesByClip) expect(frames.length).toBeGreaterThan(5);
    // Persist the scorecard for inspection / the iteration loop.
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'pipeline-scorecard.json'), JSON.stringify(sc, null, 2));
  });

  it('separates emotions well above chance', () => {
    const chance = 1 / sc.meta.labels.length;
    expect(sc.discriminability.accuracy).toBeGreaterThan(chance + 0.15);
  });

  it('lights up the expected channel per emotion (signatures)', () => {
    expect(sc.signatures.laugh ?? 0).toBeGreaterThan(0.4);
    expect(sc.signatures.yell ?? 0).toBeGreaterThan(0.4);
    expect(sc.signatures.question ?? 0).toBeGreaterThan(0.3);
    expect(sc.signatures.excited ?? 0).toBeGreaterThan(0.3);
  });

  it('reports per-channel liveliness and a coverage figure', () => {
    expect(sc.liveliness.coverage).toBeGreaterThan(0);
    expect(sc.liveliness.coverage).toBeLessThanOrEqual(1);
    // amplitude must always be a live channel (it drives the mouth).
    expect(sc.liveliness.perChannelStd.amplitude).toBeGreaterThan(0.02);
  });

  it('extracts a representative pose per emotion for Tier-2', () => {
    const poses = representativePoses(result);
    expect(Object.keys(poses).length).toBe(sc.meta.labels.length);
  });
});

// Tier-2 scores the layer the user actually complains about: do the
// per-animal Renders turn the prosody channels into visible face
// motion? The synthetic Tier-1 signal can be perfect while faces stay
// dead, so this tier is measured independently against components.tsx.
describe('expressivity Tier-2 rendered-face coverage', () => {
  const t2 = runTier2();

  it('analyzes the call-time Render of every catalog animal it can reach', () => {
    expect(t2.perAnimal.length).toBeGreaterThan(5);
    // Every analyzed animal carries a real coverage breakdown.
    for (const p of t2.perAnimal) {
      expect(p.channelCoverage).toBeGreaterThanOrEqual(0);
      expect(p.channelCoverage).toBeLessThanOrEqual(1);
      expect(p.liveChannels.length + p.deadChannels.length).toBe(
        EXPRESSION_CHANNELS.length,
      );
      expect(p.regionsMoved.length + p.missingRegions.length).toBe(
        FACIAL_REGIONS.length,
      );
    }
  });

  it('does not regress below the captured face-coverage floor', () => {
    // Guard, not a target. The loop ratchets this up; this catches a
    // change that makes avatars LESS expressive than today's baseline.
    expect(t2.overall).toBeGreaterThanOrEqual(TIER2_FLOOR);
  });

  it('surfaces the eyes-never-react gap as a tracked number', () => {
    // No animal makes the eyes respond to emotion when the shared Eyes
    // helper is blink-only. It exists so the loop has an explicit dial
    // to turn, and so closing the gap is observable.
    expect(t2.eyesExpressiveFraction).toBeGreaterThanOrEqual(0);
    expect(t2.eyesExpressiveFraction).toBeLessThanOrEqual(1);
  });

  it('surfaces the react-to-yell gap as a tracked number', () => {
    // Sustained loudness already drives the mouth on every animal; this
    // tracks whether anything reacts to a shout with a NON-mouth pose
    // (recoil/brow/eye). The renderer-side analogue of the event
    // detector's laugh/gasp fix.
    expect(t2.loudnessReactiveFraction).toBeGreaterThanOrEqual(0);
    expect(t2.loudnessReactiveFraction).toBeLessThanOrEqual(1);
  });

  it('persists the combined scorecard for the iteration loop', () => {
    const harness = runHarness();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'tier2-scorecard.json'),
      JSON.stringify(t2, null, 2),
    );
    writeFileSync(
      join(OUT_DIR, 'harness-scorecard.json'),
      JSON.stringify(harness, null, 2),
    );
    expect(harness.overall).toBeGreaterThan(0);
    expect(harness.overall).toBeLessThanOrEqual(1);
  });
});
