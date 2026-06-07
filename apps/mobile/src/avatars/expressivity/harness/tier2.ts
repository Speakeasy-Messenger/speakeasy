/**
 * Tier-2: facial-expressivity coverage of the per-animal Renders.
 *
 * Tier-1 proves the *signal* exists and is emotion-distinct. But the
 * user's actual complaint ("mouth flits, no eyes, no expression on
 * laugh/yell") lives one layer down: the per-animal `Render` /
 * `RenderCall` functions in `components.tsx` decide which prosody
 * channels become visible face motion. A channel can be loud and
 * discriminable on the wire and still produce a dead face if no
 * Render wires it to a transform.
 *
 * We cannot render the SVG off-device — in vitest `react-native` is a
 * bare mock (no Animated, no SVG) and there is no rasterizer. So this
 * scores the layer *statically*: parse `components.tsx`, and for each
 * animal's call-time Render measure
 *   1. CHANNEL COVERAGE — which expression channels (pitchTrend,
 *      expressiveness, activity, mouthShape) actually flow into an
 *      animated transform, vs sit unread.
 *   2. REGION COVERAGE — which facial regions move (head/ears, brow,
 *      eyes, mouth, cheek). The eyes are the headline gap: the shared
 *      `Eyes` helper only takes the blink `eyeScale`, so no animal
 *      makes the eyes react to emotion today.
 *
 * IMPORTANT — what this does and does NOT measure. It measures
 * *wiring* (does a channel reach a motion prop), not *magnitude* (how
 * far it moves) or *aesthetics*. Magnitude is guarded by Tier-1 (the
 * signal has range) plus a human PNG checkpoint on-device. A future
 * upgrade can lift each animal's channel→pose mapping into a pure
 * function (like Tier-1's pipeline) and measure real deltas; until
 * then this is the deterministic, no-render proxy that is RED today
 * and goes green only as Renders consume more channels / regions.
 *
 * Pure: reads source text + the TypeScript AST. No react-native, no
 * rendering, no native deps — runs in the same node vitest env as
 * Tier-1.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Channels that carry emotional nuance (vs low-level pitchNorm/zcr). */
export const EXPRESSION_CHANNELS = [
  'pitchTrend',
  'expressiveness',
  'activity',
  'mouthShape',
] as const;
export type ExpressionChannel = (typeof EXPRESSION_CHANNELS)[number];

/** Facial regions a lively avatar should be able to move. */
export const FACIAL_REGIONS = ['head', 'brow', 'eyes', 'mouth', 'cheek'] as const;
export type FacialRegion = (typeof FACIAL_REGIONS)[number];

// ─────────────────────────────────────────────────────────────────────
// MAGNITUDE GATE (committee follow-up).
//
// Tier-2's coverage score answers "is the channel WIRED to a transform."
// It went green while faces were flat because a channel can be wired to a
// 1.0→1.01 interpolation and score full coverage while moving nothing.
// The magnitude gate answers the missing question: at the input a channel
// ACTUALLY reaches on a real (compressed) call, does the transform move
// far enough to SEE? It's a static proxy for "render real-call frames and
// measure pixels" — it reads each interpolation's outputRange and floors
// the realistic output delta, rather than trusting that a wire exists.

/**
 * Per-channel input a real call reaches at a p90 "animated moment",
 * AFTER the renderer's PROSODY_FULL expansion (AvatarRenderer expands the
 * compressed wire value onto [0,1] before the per-animal interpolations
 * see it). Derived from measured real-call stats / expansion divisors:
 *   amplitude   raw p90 0.21 / 0.35 ≈ 0.60
 *   mouthShape  raw p90 0.20 / 0.30 ≈ 0.67
 *   expressiveness raw p90 0.62 / 0.60 → 1.0 (clamped)
 *   activity    raw p90 ~0.50 / 0.85 ≈ 0.59
 *   pitchTrend  smoothed real trend is tiny (±~0.07) / 0.40 ≈ 0.18
 * `amplitude` here is BOTH the prosody channel and the audioLevel prop
 * the jaw/recoil read (same realistic ceiling).
 */
const REAL_INPUT_P90: Record<string, number> = {
  amplitude: 0.6,
  mouthShape: 0.67,
  expressiveness: 1.0,
  activity: 0.59,
  pitchTrend: 0.18,
  pitchNorm: 0.5,
  zcrNorm: 0.5,
};

/** Kind of transform an interpolation's output drives — sets the unit and
 *  thus the perceptibility floor. */
type MotionKind = 'rotation' | 'translate' | 'scale' | 'opacity';

/** Smallest output delta (over rest→real-p90 input) that reads as motion
 *  on a call-sized avatar. Below this the motion is "wired but dead." */
const PERCEPTIBILITY_FLOOR: Record<MotionKind, number> = {
  rotation: 3, // degrees
  translate: 1.5, // px in the 100-unit viewBox
  scale: 0.08, // 8% size change
  opacity: 0.25, // alpha change
};

/** Classify the transform kind from the animated variable / JSX prop name.
 *  Order matters: opacity first (so "opaci*ty*" isn't read as a `ty`
 *  translate), then scale/rotation keywords, then translate (axis suffixes
 *  `Tx/Ty/Dx/Dy` matched at the end, plus motion words). */
function motionKindForName(name: string): MotionKind {
  const n = name.toLowerCase();
  if (/opacity|opac|alpha/.test(n)) return 'opacity';
  if (/scale|perk|flare|spread|widen|squint|wide/.test(n)) return 'scale';
  if (/rot|tilt|angle|swivel/.test(n)) return 'rotation';
  if (/(tx|ty|dx|dy)$|translate|recoil|bob|nod|drop|shift|sway|jolt|lean|twitch/.test(n))
    return 'translate';
  // Default: most bare animated vars feed a scale (the dominant idiom).
  return 'scale';
}

/** Evaluate a piecewise-linear interpolation (RN `interpolate` semantics,
 *  clamped at the ends) at input `x`. */
function evalInterp(inRange: number[], outRange: number[], x: number): number {
  if (inRange.length < 2 || inRange.length !== outRange.length) return outRange[0] ?? 0;
  if (x <= inRange[0]!) return outRange[0]!;
  if (x >= inRange[inRange.length - 1]!) return outRange[outRange.length - 1]!;
  for (let i = 0; i < inRange.length - 1; i++) {
    const a = inRange[i]!;
    const b = inRange[i + 1]!;
    if (x >= a && x <= b) {
      const t = b === a ? 0 : (x - a) / (b - a);
      return outRange[i]! + t * (outRange[i + 1]! - outRange[i]!);
    }
  }
  return outRange[outRange.length - 1]!;
}

/** A motion whose realistic-input output delta falls below the floor —
 *  wired, but won't visibly move on a real call. */
export interface WeakMotion {
  region: FacialRegion;
  channel: string;
  kind: MotionKind;
  /** |output(realP90) − output(rest)|. */
  magnitude: number;
  floor: number;
}

export interface AnimalExpressivity {
  animalId: string;
  /** Which Render we scored — the call variant if present, else default. */
  variant: 'call' | 'default';
  renderName: string;
  liveChannels: ExpressionChannel[];
  deadChannels: ExpressionChannel[];
  regionsMoved: FacialRegion[];
  missingRegions: FacialRegion[];
  /** True iff a prosody channel reaches the eyes (beyond the blink timer). */
  eyesExpressive: boolean;
  /** True iff sustained loudness (the `amplitude` prop or
   *  prosody?.amplitude) drives a NON-mouth pose — a recoil / brow /
   *  eye reaction to shouting, beyond the baseline amplitude→mouth
   *  scale every animal already has. This is the "react to a yell"
   *  dimension: yelling is a continuous loud state (no discrete
   *  event), so the renderer, not the event detector, must answer it. */
  loudnessReactive: boolean;
  channelCoverage: number; // liveChannels / EXPRESSION_CHANNELS
  regionCoverage: number; // regionsMoved / FACIAL_REGIONS
  /** Channel-driven motions wired but too small to see at real-call input
   *  (the magnitude gate — wiring present, pixels absent). */
  magnitudeWeak: WeakMotion[];
  score: number; // 0.45*channel + 0.45*region + 0.10*loudnessReactive
}

export interface Tier2Scorecard {
  /** Mean per-animal score across all analyzable call-time Renders. */
  overall: number;
  /** Fraction of analyzed animals whose eyes react to emotion. */
  eyesExpressiveFraction: number;
  /** Fraction of analyzed animals that react to a sustained yell
   *  (loudness → a non-mouth pose). 0 today — the "react to yelling"
   *  gap, the renderer-side analogue of the event-detector fix. */
  loudnessReactiveFraction: number;
  perAnimal: AnimalExpressivity[];
  /** Total channel-driven motions across all animals that are wired but
   *  fall below the perceptibility floor at real-call input — the
   *  magnitude gate's headline. High = lots of motion that won't read. */
  weakMotionCount: number;
  /** Animals in the catalog whose Render body lives in another file
   *  (rares/legendaries) and so isn't analyzed here yet. */
  notAnalyzed: string[];
  /** The single worst (animal, dead-channel/region) cells — the
   *  iteration loop targets these first. */
  worstCells: Array<{ animalId: string; kind: 'channel' | 'region'; name: string }>;
}

/**
 * Map a channel-derived animated variable to the facial region it
 * drives, by keyword in the variable name. The per-animal Renders use
 * descriptive names (`leftEarRot`, `browScale`, `cheekOpacity`,
 * `mouthShapeX`, a hypothetical `eyeWiden`), so the name is a reliable
 * region tag — and it updates automatically when a Render adds a new
 * animated region. Returns undefined for names with no region keyword.
 */
function regionForVarName(name: string): FacialRegion | undefined {
  const n = name.toLowerCase();
  if (/eye|lid|blink|squint|wink|widen/.test(n)) return 'eyes';
  if (/brow|eyebrow/.test(n)) return 'brow';
  if (/cheek|blush/.test(n)) return 'cheek';
  if (/mouth|jaw|lip|muzzle|beak|snout/.test(n)) return 'mouth';
  if (/ear|head|tilt|rot|tuft|whisker|antenna|crest|nod|bob|recoil|lean|jolt|flinch|brace|shake/.test(n))
    return 'head';
  return undefined;
}

/** All channels referenced as `prosody?.X` / `prosody.X` in a body. */
function referencedChannels(body: string): Set<string> {
  const found = new Set<string>();
  for (const ch of EXPRESSION_CHANNELS) {
    if (new RegExp(`prosody\\s*\\??\\.\\s*${ch}\\b`).test(body)) found.add(ch);
  }
  return found;
}

interface RenderAnalysis {
  liveChannels: ExpressionChannel[];
  regionsMoved: FacialRegion[];
  eyesExpressive: boolean;
  loudnessReactive: boolean;
  weakMotions: WeakMotion[];
}

/**
 * Extract every named channel-driven interpolation and flag those whose
 * realistic-input (real-call p90) output delta falls below the
 * perceptibility floor for its transform kind. Matches the dominant
 * idiom `const NAME = ALIAS ? ALIAS.interpolate({ inputRange:[…],
 * outputRange:[…] }) : …`. Direct JSX interpolations are not magnitude-
 * checked in v1 (rare in these bodies).
 */
function extractWeakMotions(
  body: string,
  srcAlias: Map<string, ExpressionChannel>,
): WeakMotion[] {
  const weak: WeakMotion[] = [];
  const re =
    /const\s+(\w+)\s*=\s*(\w+)\s*\?\s*\2\s*\.\s*interpolate\(\{\s*inputRange:\s*(\[[^\]]*\])\s*,\s*outputRange:\s*(\[[^\]]*\])/g;
  for (const m of body.matchAll(re)) {
    const [, varName, alias, inLit, outLit] = m;
    const channel = srcAlias.get(alias!);
    if (!channel) continue;
    const region = regionForVarName(varName!);
    if (!region) continue;
    const parse = (lit: string): number[] =>
      lit
        .slice(1, -1)
        .split(',')
        .map((s) => parseFloat(s.trim()))
        .filter((n) => !Number.isNaN(n));
    const inRange = parse(inLit!);
    const outRange = parse(outLit!);
    if (inRange.length < 2 || inRange.length !== outRange.length) continue;
    const kind = motionKindForName(varName!);
    const real = REAL_INPUT_P90[channel] ?? 0.6;
    // Rest input: 0 for unipolar channels, 0 for signed (neutral) too.
    const mag = Math.abs(evalInterp(inRange, outRange, real) - evalInterp(inRange, outRange, 0));
    const floor = PERCEPTIBILITY_FLOOR[kind];
    if (mag < floor) {
      weak.push({ region, channel, kind, magnitude: Number(mag.toFixed(3)), floor });
    }
  }
  return weak;
}

/**
 * Analyze one Render's source body. A channel is "live" when it is
 * referenced AND its value is consumed — in these bodies every
 * referenced channel is interpolated into a motion prop, so a
 * reference is the liveness signal. Regions are derived from the
 * channel-fed animated variables. We additionally require that a live
 * channel maps to at least one region, so a dangling `const x =
 * prosody?.activity` with no downstream use does not inflate the score.
 */
function analyzeRenderBody(body: string): RenderAnalysis {
  const refs = referencedChannels(body);

  // Collect animated variables fed (directly or via a `Src` alias) by
  // a prosody channel, and which channel feeds each. Two shapes appear:
  //   const trendSrc = prosody?.pitchTrend;  const leftEarRot = trendSrc ? trendSrc.interpolate(...)
  //   const closedOpacity = prosody?.mouthShape.interpolate(...)
  //   openness={prosody?.mouthShape ?? 0}            (direct, no named var)
  const srcAlias = new Map<string, ExpressionChannel>(); // aliasVar -> channel
  for (const m of body.matchAll(
    /const\s+(\w+)\s*=\s*prosody\s*\??\.\s*(\w+)\b/g,
  )) {
    const [, alias, ch] = m;
    if ((EXPRESSION_CHANNELS as readonly string[]).includes(ch!)) {
      srcAlias.set(alias!, ch as ExpressionChannel);
    }
  }

  const regions = new Set<FacialRegion>();
  const liveChannels = new Set<ExpressionChannel>();

  // Named animated vars derived from an alias: `const browScale = exprSrc ? exprSrc.interpolate`
  for (const m of body.matchAll(/const\s+(\w+)\s*=\s*(\w+)\s*[?]/g)) {
    const [, varName, alias] = m;
    const ch = srcAlias.get(alias!);
    if (!ch) continue;
    const region = regionForVarName(varName!);
    if (region) {
      regions.add(region);
      liveChannels.add(ch);
    }
  }

  // Direct channel use in a motion prop, no named var, e.g.
  //   openness={prosody?.mouthShape ?? 0}
  //   rotation={prosody?.pitchTrend.interpolate(...)}
  for (const m of body.matchAll(
    /(\w+)\s*=\s*\{\s*prosody\s*\??\.\s*(\w+)\b/g,
  )) {
    const [, prop, ch] = m;
    if (!(EXPRESSION_CHANNELS as readonly string[]).includes(ch!)) continue;
    // Map the JSX prop name to a region. `openness` is the MouthMorph
    // crossfade; transform props attach to whatever element — fall back
    // to the prop-name region or 'mouth' for openness.
    const region =
      prop === 'openness'
        ? 'mouth'
        : regionForVarName(prop!) ?? (prop === 'rotation' ? 'head' : undefined);
    if (region) {
      regions.add(region);
      liveChannels.add(ch as ExpressionChannel);
    }
  }

  // A channel referenced but never mapped to a region is NOT counted
  // live (guards against dead reads gaming the score). But if we found
  // a reference and an alias yet missed the downstream var (unusual
  // naming), still count it live without a region so coverage reflects
  // consumption — conservative: only when an alias exists for it.
  for (const ch of refs) {
    if (!liveChannels.has(ch as ExpressionChannel)) {
      const aliased = [...srcAlias.values()].includes(ch as ExpressionChannel);
      if (aliased && [...srcAlias.entries()].some(([a]) =>
        new RegExp(`\\b${a}\\b`).test(body.replace(/const\s+\w+\s*=\s*prosody[^\n]*/g, '')),
      )) {
        liveChannels.add(ch as ExpressionChannel);
      }
    }
  }

  // Yell reaction: does sustained loudness drive a NON-mouth pose?
  // Sources of the loudness signal in a Render are the `amplitude` prop
  // (destructured) and `prosody?.amplitude`. The mouth is already
  // amplitude-driven via `mouthScale` for every animal, so only a
  // non-mouth use (recoil / brow / eye / head) counts as reacting to a
  // yell. Build the set of amplitude-source tokens, then look for a
  // derived animated var or JSX prop on a non-mouth region.
  const ampSources = new Set<string>(['amplitude']);
  for (const m of body.matchAll(/const\s+(\w+)\s*=\s*prosody\s*\??\.\s*amplitude\b/g)) {
    ampSources.add(m[1]!);
  }
  let loudnessReactive = false;
  for (const m of body.matchAll(/const\s+(\w+)\s*=\s*(\w+)\s*[?.]/g)) {
    if (ampSources.has(m[2]!)) {
      const r = regionForVarName(m[1]!);
      if (r && r !== 'mouth') loudnessReactive = true;
    }
  }
  for (const m of body.matchAll(
    /(\w+)\s*=\s*\{\s*(?:amplitude\b|prosody\s*\??\.\s*amplitude\b)/g,
  )) {
    const prop = m[1]!;
    const r = regionForVarName(prop) ?? (prop === 'rotation' ? 'head' : undefined);
    if (r && r !== 'mouth') loudnessReactive = true;
  }

  // PRIMITIVE recognition (post-redesign vocabulary). The new mouth/eye
  // motion lives in reusable components driven by the `amplitude` prop +
  // acoustic events, NOT the prosody-channel interpolations this parser
  // tracks — so detect them by element name, else they read as false
  // "missing mouth / dead eyes". `<Jaw>` and `<BeakGap>` are the loudness
  // mouth; `<ExprEyes>` reacts to loudness (wide) + the laugh event (arch).
  const hasJaw = /<Jaw\b/.test(body);
  const hasBeak = /<BeakGap\b/.test(body);
  const hasExprEyes = /<ExprEyes\b/.test(body);
  if (hasJaw || hasBeak) regions.add('mouth');
  let eyesExpressive = regions.has('eyes');
  if (hasExprEyes) {
    regions.add('eyes');
    eyesExpressive = true; // loudness-wide + laugh-arch + idle gaze
  }
  // The loudness jaw/beak is itself a mouth-region loudness reaction, but
  // `loudnessReactive` deliberately counts only NON-mouth yell reactions,
  // so the jaw doesn't flip it (the recoil/brow/eye uses still do).

  const weakMotions = extractWeakMotions(body, srcAlias);

  return {
    liveChannels: [...liveChannels],
    regionsMoved: [...regions],
    eyesExpressive,
    loudnessReactive,
    weakMotions,
  };
}

/** Extract `const Name: AnimalRender = (...) => {...}` bodies + the
 *  ANIMALS catalog (id -> Render / RenderCall identifier names). */
function parseComponents(source: string): {
  renderBodies: Map<string, string>;
  catalog: Array<{ id: string; render?: string; renderCall?: string }>;
} {
  const sf = ts.createSourceFile(
    'components.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const renderBodies = new Map<string, string>();
  const catalog: Array<{ id: string; render?: string; renderCall?: string }> = [];

  const isAnimalRender = (node: ts.VariableDeclaration): boolean =>
    !!node.type && node.type.getText(sf) === 'AnimalRender';

  function visit(node: ts.Node): void {
    // const X: AnimalRender = (...) => {...}
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          isAnimalRender(decl) &&
          decl.initializer
        ) {
          renderBodies.set(decl.name.text, decl.initializer.getText(sf));
        }
        // export const ANIMALS: Record<string, AnimalDef> = { ... }
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === 'ANIMALS' &&
          decl.initializer &&
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          for (const prop of decl.initializer.properties) {
            if (
              !ts.isPropertyAssignment(prop) ||
              !ts.isObjectLiteralExpression(prop.initializer)
            )
              continue;
            const id = prop.name.getText(sf).replace(/['"]/g, '');
            const entry: { id: string; render?: string; renderCall?: string } = {
              id,
            };
            for (const sub of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(sub)) continue;
              const key = sub.name.getText(sf);
              const val = sub.initializer.getText(sf);
              if (key === 'Render') entry.render = val;
              if (key === 'RenderCall') entry.renderCall = val;
            }
            catalog.push(entry);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { renderBodies, catalog };
}

/**
 * Build the Tier-2 scorecard from `components.tsx`. `sourcePath`
 * defaults to the production file; tests/loops can point it elsewhere.
 */
export function runTier2(
  sourcePath: string = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'components.tsx',
  ),
): Tier2Scorecard {
  const source = readFileSync(sourcePath, 'utf8');
  const { renderBodies, catalog } = parseComponents(source);

  const perAnimal: AnimalExpressivity[] = [];
  const notAnalyzed: string[] = [];

  for (const entry of catalog) {
    // Private calls use RenderCall when present; that's the surface the
    // user complained about. Fall back to the default Render.
    const variant: 'call' | 'default' = entry.renderCall ? 'call' : 'default';
    const renderName = entry.renderCall ?? entry.render;
    if (!renderName) {
      notAnalyzed.push(entry.id);
      continue;
    }
    const body = renderBodies.get(renderName);
    if (!body) {
      // Render lives in another file (rares/legendaries import) — not
      // analyzed in v1. Logged so coverage gaps are explicit, not silent.
      notAnalyzed.push(entry.id);
      continue;
    }
    const a = analyzeRenderBody(body);
    const liveChannels = a.liveChannels;
    const deadChannels = EXPRESSION_CHANNELS.filter((c) => !liveChannels.includes(c));
    const missingRegions = FACIAL_REGIONS.filter((r) => !a.regionsMoved.includes(r));
    const channelCoverage = liveChannels.length / EXPRESSION_CHANNELS.length;
    const regionCoverage = a.regionsMoved.length / FACIAL_REGIONS.length;
    perAnimal.push({
      animalId: entry.id,
      variant,
      renderName,
      liveChannels,
      deadChannels,
      regionsMoved: a.regionsMoved,
      missingRegions,
      eyesExpressive: a.eyesExpressive,
      loudnessReactive: a.loudnessReactive,
      channelCoverage,
      regionCoverage,
      magnitudeWeak: a.weakMotions,
      score:
        0.45 * channelCoverage +
        0.45 * regionCoverage +
        0.1 * (a.loudnessReactive ? 1 : 0),
    });
  }

  perAnimal.sort((x, y) => x.score - y.score);
  const overall = perAnimal.length
    ? perAnimal.reduce((n, p) => n + p.score, 0) / perAnimal.length
    : 0;
  const eyesExpressiveFraction = perAnimal.length
    ? perAnimal.filter((p) => p.eyesExpressive).length / perAnimal.length
    : 0;
  const loudnessReactiveFraction = perAnimal.length
    ? perAnimal.filter((p) => p.loudnessReactive).length / perAnimal.length
    : 0;

  // Worst cells: the lowest-scoring animals' missing channels/regions,
  // the targets the loop attacks first.
  const worstCells: Tier2Scorecard['worstCells'] = [];
  for (const p of perAnimal.slice(0, 4)) {
    for (const c of p.deadChannels)
      worstCells.push({ animalId: p.animalId, kind: 'channel', name: c });
    for (const r of p.missingRegions)
      worstCells.push({ animalId: p.animalId, kind: 'region', name: r });
  }

  const weakMotionCount = perAnimal.reduce((n, p) => n + p.magnitudeWeak.length, 0);

  return {
    overall,
    eyesExpressiveFraction,
    loudnessReactiveFraction,
    weakMotionCount,
    perAnimal,
    notAnalyzed,
    worstCells,
  };
}

