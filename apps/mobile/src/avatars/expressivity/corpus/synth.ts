/**
 * Synthetic BOOTSTRAP corpus for the expressivity harness.
 *
 * This is scaffolding, NOT the real evaluation set: it lets us build and
 * self-test the whole harness (pipeline → params → render → score) before
 * the user records real clips. Each generator is crude on purpose — it
 * exercises the production feature pipeline's channels in distinct ways so
 * the discriminability metric has something to separate. Real recorded
 * clips (corpus/manifest.json) replace this for the actual baseline; see
 * corpus/index.ts → loadCorpus().
 *
 * No Math.random (blocked in this runtime + we want determinism): a seeded
 * LCG backs the "unvoiced/breath" noise so runs are byte-identical.
 */

export type EmotionLabel =
  | 'neutral'
  | 'laugh'
  | 'yell'
  | 'question'
  | 'sad'
  | 'excited'
  | 'quiet-filler';

export interface Clip {
  clipId: string;
  label: EmotionLabel;
  samples: Float32Array;
  sampleRate: number;
}

const SR = 48_000;
const TWO_PI = Math.PI * 2;

/** Deterministic [-1, 1) noise via a 32-bit LCG. */
function makeNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

interface Seg {
  durMs: number;
  kind: 'voiced' | 'unvoiced' | 'silence';
  /** F0 at segment start (Hz). */
  f0?: number;
  /** F0 at segment end (Hz); defaults to f0 (no sweep). */
  f0End?: number;
  /** Peak amplitude [0, 1]. */
  amp?: number;
}

/** Render a segment list into one mono Float32 clip. */
function render(segs: Seg[], seed: number): Float32Array {
  const noise = makeNoise(seed);
  const total = segs.reduce((n, s) => n + Math.round((s.durMs / 1000) * SR), 0);
  const out = new Float32Array(total);
  let phase = 0;
  let w = 0;
  for (const s of segs) {
    const n = Math.round((s.durMs / 1000) * SR);
    const amp = s.amp ?? 0.3;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      if (s.kind === 'silence') {
        out[w++] = 0;
      } else if (s.kind === 'unvoiced') {
        out[w++] = noise() * amp;
      } else {
        // Voiced: phase-continuous sine sweep f0 → f0End, plus a 2nd
        // harmonic so autocorrelation locks firmly (>0.85 voiced gate).
        const f0 = (s.f0 ?? 150) * (1 - t) + (s.f0End ?? s.f0 ?? 150) * t;
        phase += (TWO_PI * f0) / SR;
        out[w++] = amp * (Math.sin(phase) + 0.35 * Math.sin(2 * phase)) * 0.74;
      }
    }
  }
  return out;
}

/** Repeat a voiced burst + gap pattern (the rhythmic core of a laugh). */
function laughSegs(bursts: number, f0: number, amp: number): Seg[] {
  const segs: Seg[] = [{ durMs: 200, kind: 'voiced', f0, amp: amp * 0.5 }];
  for (let i = 0; i < bursts; i++) {
    segs.push({ durMs: 110, kind: 'voiced', f0: f0 + i * 6, amp });
    segs.push({ durMs: 70, kind: 'unvoiced', amp: amp * 0.5 });
  }
  return segs;
}

/**
 * The bootstrap corpus: 2–3 variants per label so leave-one-out
 * classification has multiple samples per class. ~1.5–3 s each.
 */
export function synthCorpus(): Clip[] {
  const c: Clip[] = [];
  const add = (label: EmotionLabel, v: number, segs: Seg[], seed: number) =>
    c.push({ clipId: `${label}-${v}`, label, samples: render(segs, seed), sampleRate: SR });

  // neutral: steady, low variance, moderate level.
  add('neutral', 1, [{ durMs: 2000, kind: 'voiced', f0: 150, amp: 0.3 }], 11);
  add('neutral', 2, [{ durMs: 2000, kind: 'voiced', f0: 135, amp: 0.28 }], 12);
  add('neutral', 3, [{ durMs: 1800, kind: 'voiced', f0: 165, amp: 0.32 }], 13);

  // laugh: rapid voiced/unvoiced bursts, amp > 0.25 → laugh event + activity.
  add('laugh', 1, laughSegs(7, 210, 0.55), 21);
  add('laugh', 2, laughSegs(9, 240, 0.5), 22);
  add('laugh', 3, laughSegs(6, 190, 0.6), 23);

  // yell: loud sustained voiced, high pitch, slight wobble. A real yell
  // drives the mic HOT — amp > 1 here is deliberate (a clipping/hot
  // signal), so the windowed RMS the production extractor computes
  // clears the yell signature's "sustained-loud" bar (RMS > 0.6), which
  // is tuned for real shouted speech. The earlier 0.85–0.9 amps yielded
  // RMS ≈ 0.5 through the render's 0.74 headroom factor and read as
  // merely "moderate," not "loud" — a bootstrap-loudness gap, not a
  // pipeline bug.
  add('yell', 1, [{ durMs: 1800, kind: 'voiced', f0: 280, f0End: 300, amp: 1.4 }], 31);
  add('yell', 2, [{ durMs: 1600, kind: 'voiced', f0: 300, f0End: 290, amp: 1.32 }], 32);
  add('yell', 3, [
    { durMs: 120, kind: 'silence' },
    { durMs: 1600, kind: 'voiced', f0: 260, f0End: 310, amp: 1.36 },
  ], 33);

  // question: rising pitch toward the end, moderate level.
  add('question', 1, [{ durMs: 1800, kind: 'voiced', f0: 130, f0End: 320, amp: 0.35 }], 41);
  add('question', 2, [
    { durMs: 700, kind: 'voiced', f0: 150, amp: 0.33 },
    { durMs: 900, kind: 'voiced', f0: 150, f0End: 330, amp: 0.36 },
  ], 42);

  // sad / sigh: leading silence, sustained voiced falling pitch, decaying.
  add('sad', 1, [
    { durMs: 300, kind: 'silence' },
    { durMs: 1500, kind: 'voiced', f0: 220, f0End: 110, amp: 0.34 },
    { durMs: 300, kind: 'silence' },
  ], 51);
  add('sad', 2, [
    { durMs: 300, kind: 'silence' },
    { durMs: 1400, kind: 'voiced', f0: 200, f0End: 120, amp: 0.3 },
  ], 52);

  // excited: singsong — wide pitch oscillation → high expressiveness.
  const singsong = (cycles: number, amp: number): Seg[] => {
    const segs: Seg[] = [];
    for (let i = 0; i < cycles; i++) {
      const up = i % 2 === 0;
      segs.push({ durMs: 220, kind: 'voiced', f0: up ? 160 : 300, f0End: up ? 300 : 160, amp });
    }
    return segs;
  };
  add('excited', 1, singsong(8, 0.5), 61);
  add('excited', 2, singsong(7, 0.55), 62);

  // quiet-filler: near-silence + breath noise + one tiny voiced blip.
  add('quiet-filler', 1, [
    { durMs: 700, kind: 'unvoiced', amp: 0.03 },
    { durMs: 150, kind: 'voiced', f0: 140, amp: 0.08 },
    { durMs: 900, kind: 'unvoiced', amp: 0.025 },
  ], 71);
  add('quiet-filler', 2, [
    { durMs: 1600, kind: 'unvoiced', amp: 0.035 },
  ], 72);

  return c;
}

export const EMOTION_LABELS: EmotionLabel[] = [
  'neutral',
  'laugh',
  'yell',
  'question',
  'sad',
  'excited',
  'quiet-filler',
];
