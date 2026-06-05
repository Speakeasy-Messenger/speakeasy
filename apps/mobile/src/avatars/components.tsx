/**
 * 12 launch-set animal renderers — see AVATAR-SYSTEM.md §2 + the visual
 * reference at `speakeasy-animals.html`.
 *
 * Each animal is a function from `(eyeScale, mouthScale) → SVG tree`.
 * The renderer wraps the result in an Animated.View for breathing; the
 * eye + mouth groups consume the Animated.Value handles directly via
 * react-native-svg's Animated component support.
 *
 * Construction rules from spec §2.2:
 *  - Three colors max: brass, bone, ink.
 *  - No strokes (with one exception: stag antlers — geometric branching
 *    is impractical without strokes).
 *  - 100×100 viewBox.
 *  - Eye and mouth groups receive `originX/originY` set to the pivot,
 *    so `scaleY` collapses around the right point.
 */

import React from 'react';
import { Animated } from 'react-native';
import Svg, {
  Circle,
  Ellipse,
  G,
  Line,
  Path,
  Polygon,
  Rect,
} from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider.js';
import type { AnimalDef, AnimalRender, AnimalRenderProps } from './types.js';
import { Lynx } from './rares/lynx.js';
import { Koi } from './rares/koi.js';
import { Raven } from './rares/raven.js';
import { Frog } from './rares/frog.js';
import { Snake } from './rares/snake.js';
import { Peacock } from './rares/peacock.js';
import { Hawk } from './rares/hawk.js';
import { Squirrel } from './rares/squirrel.js';
import { Crab } from './rares/crab.js';
import { Beetle } from './rares/beetle.js';
import { Anglerfish } from './rares/anglerfish.js';
import { Seahorse } from './rares/seahorse.js';
import { Dragon } from './legendaries/dragon.js';
import { Phoenix } from './legendaries/phoenix.js';
import { Turtle } from './legendaries/turtle.js';
import { Manticore } from './legendaries/manticore.js';
import { makePlaceholder } from './placeholder.js';

// react-native-svg's animated wrappers. Passed Animated.Values via the
// `scaleY` prop; native driver isn't supported on SVG transforms but the
// JS-driver overhead at our update rates (60Hz idle, 30Hz audio) is in
// the noise on a release build.
const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);

// Brand-locked colors — duplicated here from `theme/tokens.ts` so the
// SVG markup is fully self-contained (animal SVGs are intended to be
// art assets, not theme-aware components).
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

/**
 * Per-theme contrast outline (#12). The marks hard-code BRASS, BONE
 * ("white") + INK ("black") with no theme awareness. BRASS reads cleanly
 * on BOTH the cream (light) and aubergine (dark) surfaces, so it never
 * needs an edge. Only the shape whose fill matches the *background* loses
 * contrast: BONE shapes vanish on cream (light), INK shapes vanish on
 * aubergine (dark).
 *
 * Fix: render the mark a SECOND time BEHIND the real one, but edge ONLY
 * the shapes whose fill is the vanishing color for the current mode
 * (`target`) — recolored to the contrast color (`edgeColor`) and grown by
 * an even stroke, so a hairline pokes out past those shapes' silhouette.
 * Every other shape (brass, the already-contrasting color, eyes, interior
 * details) is dropped from the edge layer. Because the edge sits behind
 * the real mark, an edge that pokes out only shows where that shape is the
 * OUTER silhouette — so a brass-bodied animal (octopus, fox, owl) gets no
 * visible hairline at all (its interior bone/ink details are edged in the
 * hidden layer but the brass body draws on top and covers them), while a
 * bone-bodied heron/hare/moth (light) or ink-bodied bear/cat/bat/whale
 * (dark) gets the outline it needs.
 *
 * Pure fill/stroke (NOT a filter — react-native-svg filters don't paint on
 * Android; NOT a scale — that gives an uneven edge), so it renders
 * everywhere incl. the `toDataURL` notification path. `recolorEdge` clones
 * the mark's element tree (zero per-mark edits). Verified visually via an
 * offline resvg render before shipping.
 */
const EDGE_GROW = 3;
/** Case-insensitive hex compare — marks paint via the BRASS/BONE/INK consts. */
function sameColor(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}
function recolorEdge(
  node: React.ReactNode,
  edgeColor: string,
  target: string,
): React.ReactNode {
  if (!React.isValidElement(node)) return null;
  const p = node.props as {
    fill?: string;
    stroke?: string;
    strokeWidth?: number | string;
    children?: React.ReactNode;
  };
  const kids =
    p.children !== undefined
      ? React.Children.map(p.children, (c) => recolorEdge(c, edgeColor, target))
      : undefined;

  const hasFill = p.fill !== undefined && p.fill !== 'none';
  const hasStroke = p.stroke !== undefined && p.stroke !== 'none';
  const fillMatches = hasFill && sameColor(p.fill, target);
  // A stroke-only shape (heron neck, mouth line) contributes its silhouette
  // via the stroke; edge it when that stroke is the vanishing color.
  const strokeMatches = !hasFill && hasStroke && sameColor(p.stroke, target);

  if (fillMatches) {
    const patch: Record<string, unknown> = { fill: edgeColor, stroke: edgeColor };
    patch.strokeWidth =
      hasStroke && typeof p.strokeWidth === 'number' ? p.strokeWidth + EDGE_GROW : EDGE_GROW;
    return React.cloneElement(node, patch, kids);
  }
  if (strokeMatches) {
    const patch: Record<string, unknown> = {
      stroke: edgeColor,
      strokeWidth: typeof p.strokeWidth === 'number' ? p.strokeWidth + EDGE_GROW : EDGE_GROW,
    };
    return React.cloneElement(node, patch, kids);
  }

  // Non-matching. Structural nodes (groups / fragments / AnimatedG that
  // carry transforms but no own paint) are KEPT so matching descendants
  // still draw — their own paint is neutralized. Non-matching leaves
  // (brass shapes, eyes, the already-contrasting color) are dropped from
  // the edge layer entirely.
  if (p.children !== undefined) {
    const patch: Record<string, unknown> = {};
    if (hasFill) patch.fill = 'none';
    if (hasStroke) patch.stroke = 'none';
    return React.cloneElement(node, patch, kids);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Helper: a pair of <AnimatedG> wrappers for the left + right eye that
// pivot at the right point. Most animals use this exact shape.

function Eyes({
  leftPivot,
  rightPivot,
  scale,
  children,
}: {
  leftPivot: { x: number; y: number };
  rightPivot: { x: number; y: number };
  scale: AnimalRenderProps['eyeScale'];
  children: [React.ReactElement, React.ReactElement];
}): React.ReactElement {
  return (
    <>
      <AnimatedG originX={leftPivot.x} originY={leftPivot.y} scaleY={scale}>
        {children[0]}
      </AnimatedG>
      <AnimatedG originX={rightPivot.x} originY={rightPivot.y} scaleY={scale}>
        {children[1]}
      </AnimatedG>
    </>
  );
}

/**
 * Expressive eyes (rc.58 redesign). The old per-animal eyes only blinked
 * on a timer + scaled uniformly ("eyeWiden") — which read as "no eye
 * movement". These EYES CHANGE SHAPE with the peer's voice, the single
 * biggest expressivity win:
 *  - blow WIDE with loudness (yell / surprise),
 *  - squint into a happy upward arch when the voice is animated
 *    (cross-faded over the open eye),
 *  - DROOP when pitch falls (winding down / sad),
 * while the timer blink still multiplies the open-eye height. Pure SVG
 * helper (no hooks) so it stays inside the AnimalBody invariant; drop it
 * in where an animal's `<Eyes>` block was. All channels are the already-
 * expanded prosody Animated values (see AvatarRenderer PROSODY_FULL), so
 * ordinary speech drives the full range.
 */
function ExprEyes({
  leftCx,
  rightCx,
  cy,
  r = 8,
  blink,
  prosody,
}: {
  leftCx: number;
  rightCx: number;
  cy: number;
  r?: number;
  blink: AnimalRenderProps['eyeScale'];
  prosody?: AnimalRenderProps['prosody'];
}): React.ReactElement {
  const amp = prosody?.amplitude;
  const trend = prosody?.pitchTrend;

  // CONTINUOUS: eyes blow wide with loudness (yell / emphasis), sink on a
  // gasp. Smooth, every-frame — this is the "eyes actually move" signal.
  const wideScale = amp
    ? amp.interpolate({ inputRange: [0.45, 1], outputRange: [1, 1.5], extrapolate: 'clamp' })
    : 1;
  const droopY = trend
    ? trend.interpolate({ inputRange: [-1, -0.15, 0], outputRange: [3.5, 0, 0], extrapolate: 'clamp' })
    : 0;
  // DISCRETE: only a real laugh squints the eyes shut into a happy arch —
  // expressiveness ("animated voice") is NOT happiness, so we drive this
  // off the acoustic event, not a continuous channel. Sticky for the
  // event's ~1.5s lifetime (the receiver holds event/eventAt). Snap is
  // fine — laughs are punchy.
  const happy = prosody?.event === 'laugh';
  const happyOp = happy ? 1 : 0;
  const openOp = happy ? 0 : 1;
  // Open-eye vertical scale = blink × wide. Blink still fully closes the
  // eye; loudness makes the open eye taller.
  const openScaleY =
    typeof blink === 'number' ? blink : Animated.multiply(blink, wideScale);

  const renderEye = (cx: number, hiSign: number): React.ReactElement => (
    <>
      {/* OPEN eye — sclera + pupil + glint; taller when loud, sinks when sad. */}
      <AnimatedG opacity={openOp}>
        <AnimatedG originX={cx} originY={cy} scaleY={openScaleY} translateY={droopY}>
          <Ellipse cx={cx} cy={cy} rx={r} ry={r} fill={BONE} />
          <Ellipse cx={cx} cy={cy + 0.5} rx={r * 0.5} ry={r * 0.5} fill={INK} />
          <Circle cx={cx + 1.4 * hiSign} cy={cy - 1.4} r={1.3} fill={BONE} />
        </AnimatedG>
      </AnimatedG>
      {/* HAPPY squint — upward arch, crossfaded in over the open eye. */}
      <AnimatedPath
        d={`M ${cx - r * 1.1} ${cy + 2} Q ${cx} ${cy - r * 0.9} ${cx + r * 1.1} ${cy + 2}`}
        stroke={INK}
        strokeWidth={3.2}
        strokeLinecap="round"
        fill="none"
        opacity={happyOp}
      />
    </>
  );

  return (
    <>
      {renderEye(leftCx, 1)}
      {renderEye(rightCx, -1)}
    </>
  );
}

function Mouth({
  pivot,
  scale,
  axis,
  children,
}: {
  pivot: { x: number; y: number };
  scale: AnimalRenderProps['mouthScale'];
  axis: 'x' | 'y';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <AnimatedG
      originX={pivot.x}
      originY={pivot.y}
      scaleY={axis === 'y' ? scale : undefined}
      scaleX={axis === 'x' ? scale : undefined}
    >
      {children}
    </AnimatedG>
  );
}

/**
 * Mouth that morphs between a CLOSED path and an OPEN path via opacity
 * crossfade, driven by the prosody `mouthShape` channel (0 = closed,
 * 1 = open vowel). Replaces the scale-only `Mouth` for animals where
 * the mouth needs (a) to be visible on the face — not implied by a
 * tiny scaled polygon — and (b) to read as a *shape*, not just an
 * amplitude-driven stretch.
 *
 * Brand note: this introduces strokes for the mouth (previously
 * forbidden by the no-strokes rule from §2.2). The carve-out is
 * deliberate — the face needs a legible mouth more than the rig
 * needs a one-line spec. Thin INK strokes also sit naturally with
 * the "speakeasy menu illustration" register we're moving toward.
 *
 * Both paths render simultaneously; their opacity is `1 - openness`
 * and `openness` respectively. Path d-strings are intentionally
 * unconstrained (any structure) — we crossfade pixel coverage rather
 * than interpolate coordinates, so closed and open can be
 * structurally different shapes (a line vs. a lens, a closed triangle
 * vs. a separated upper+lower mandible).
 */
type Openness =
  | Animated.Value
  | Animated.AnimatedInterpolation<number>
  | number;

function MouthMorph({
  closedD,
  openD,
  openness,
  stroke,
  strokeWidth,
  fill,
}: {
  closedD: string;
  openD: string;
  /** Animated [0,1]. 0 = full-closed, 1 = full-open. Wire from
   *  `prosody?.mouthShape` during a call; pass the static fallback
   *  `0` when there's no prosody (chat row avatars, picker previews). */
  openness: Openness;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}): React.ReactElement {
  const closedOpacity =
    typeof openness === 'number'
      ? 1 - openness
      : openness.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  return (
    <>
      <AnimatedPath
        d={closedD}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={fill ?? 'none'}
        opacity={closedOpacity}
      />
      <AnimatedPath
        d={openD}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={fill ?? 'none'}
        opacity={openness}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────

// Fox ear pivots — base of each ear, where it meets the skull. Ears
// rotate around these points so the tip swings rather than the whole
// ear sliding. Phase 5j Private Call (rc.11): ears track `pitchTrend`
// continuously — rising pitch (curious / questioning) brings the ears
// forward, falling pitch (declarative / settled) flattens them back.
// At rest (no prosody / flat trend) ears hold at 0°.
const FOX_EAR_LEFT_PIVOT = { x: 28, y: 30 };
const FOX_EAR_RIGHT_PIVOT = { x: 72, y: 30 };

const Fox: AnimalRender = ({ eyeScale, prosody }) => {
  // pitchTrend ∈ [-1, +1] → left ear rotates from +12° (flat back,
  // falling pitch) through 0° (rest) to -6° (perked forward, rising
  // pitch). Right ear is mirrored.
  // react-native-svg's <G rotation={…}> takes a numeric degree.
  const trendSrc = prosody?.pitchTrend;
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [12, 0, -6],
      })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [-12, 0, 6],
      })
    : 0;
  return (
    <>
      <AnimatedG
        originX={FOX_EAR_LEFT_PIVOT.x}
        originY={FOX_EAR_LEFT_PIVOT.y}
        rotation={leftEarRot}
      >
        <Polygon points="18,12 38,12 28,32" fill={BRASS} />
        <Polygon points="24,18 32,18 28,28" fill={INK} />
      </AnimatedG>
      <AnimatedG
        originX={FOX_EAR_RIGHT_PIVOT.x}
        originY={FOX_EAR_RIGHT_PIVOT.y}
        rotation={rightEarRot}
      >
        <Polygon points="62,12 82,12 72,32" fill={BRASS} />
        <Polygon points="68,18 76,18 72,28" fill={INK} />
      </AnimatedG>
      {/* head */}
      <Path d="M20,28 L80,28 L74,62 L50,88 L26,62 Z" fill={BRASS} />
      {/* white chest */}
      <Path d="M38,56 L62,56 L50,86 Z" fill={BONE} />
      <Eyes
        leftPivot={{ x: 36, y: 44 }}
        rightPivot={{ x: 64, y: 44 }}
        scale={eyeScale}
      >
        <Ellipse cx={36} cy={44} rx={3.2} ry={3.2} fill={INK} />
        <Ellipse cx={64} cy={44} rx={3.2} ry={3.2} fill={INK} />
      </Eyes>
      {/* Mouth lives on the face between eyes and chest, not the chest
          itself (rc.14 dogfood feedback: fox had no visible mouth).
          Closed reads as a calm fox muzzle line dipping gently; open
          forms a small lens that bows down to read as a parted mouth. */}
      <MouthMorph
        closedD="M 45 52 Q 50 54 55 52"
        openD="M 44 51 Q 50 57 56 51 Q 50 53 44 51 Z"
        openness={prosody?.mouthShape ?? 0}
        stroke={INK}
        strokeWidth={1.4}
      />
    </>
  );
};

// Owl signature: head tilt on pitchTrend. Real-world owls rotate their
// heads dramatically; we ride the same iconic gesture with a subtle ±8°
// rotation around the face-disk center. Rising pitch tilts right
// (curious), falling tilts left (declarative).
const Owl: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const rotation = trendSrc
    ? trendSrc.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [-8, 0, 8],
      })
    : 0;
  return (
    <AnimatedG originX={50} originY={46} rotation={rotation}>
      {/* ear tufts */}
      <Polygon points="20,18 32,18 27,5" fill={BRASS} />
      <Polygon points="68,18 80,18 73,5" fill={BRASS} />
      {/* body / head */}
      <Path
        d="M18,22 Q18,18 30,18 L70,18 Q82,18 82,22 L82,76 Q82,90 50,90 Q18,90 18,76 Z"
        fill={BRASS}
      />
      {/* face disk */}
      <Ellipse cx={50} cy={46} rx={30} ry={26} fill={BONE} />
      <Eyes
        leftPivot={{ x: 38, y: 44 }}
        rightPivot={{ x: 62, y: 44 }}
        scale={eyeScale}
      >
        <G>
          <Circle cx={38} cy={44} r={8} fill={INK} />
          <Circle cx={38} cy={44} r={2.5} fill={BRASS} />
        </G>
        <G>
          <Circle cx={62} cy={44} r={8} fill={INK} />
          <Circle cx={62} cy={44} r={2.5} fill={BRASS} />
        </G>
      </Eyes>
      <Mouth pivot={{ x: 50, y: 54 }} scale={mouthScale} axis="y">
        <Polygon points="46,54 54,54 50,64" fill={INK} />
      </Mouth>
    </AnimatedG>
  );
};

// Was `Raven` pre-rc.6 — the friendly bird silhouette is now the
// `pigeon` free common; the rare illustrated raven (with head_tilt
// signature effect) takes the `raven` id and lives in `rares/raven.tsx`.
// Pigeon signature: head bob on activity. Real pigeons bob with each
// step; this rides the same cadence — high articulation rate (busy
// speech) bobs more, monotone or held notes settle still.
const Pigeon: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const translateY = activitySrc
    ? activitySrc.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -3],
      })
    : 0;
  return (
    // Profile silhouette — single eye, beak as the mouth element. The
    // beak axis is X (horizontal "click") rather than Y, since the bird
    // is in profile and a vertical scale would distort the silhouette.
    <AnimatedG translateY={translateY}>
      <Ellipse cx={42} cy={52} rx={30} ry={24} fill={INK} />
      <Eyes
        leftPivot={{ x: 38, y: 44 }}
        rightPivot={{ x: 38, y: 44 }}
        scale={eyeScale}
      >
        <Circle cx={38} cy={44} r={3} fill={BRASS} />
        {/* second eye intentionally identical — profile pose has only
            one visible eye; we re-use the slot to keep the Eyes helper
            shape consistent. */}
        <G />
      </Eyes>
      <Mouth pivot={{ x: 70, y: 52 }} scale={mouthScale} axis="x">
        <Polygon points="68,46 96,52 68,58" fill={INK} />
      </Mouth>
    </AnimatedG>
  );
};

// Hare signature: ear angle on pitchTrend. Rabbits/hares rotate their
// long ears toward sounds of interest — rising pitch (alert) splays the
// ears outward, falling pitch (relaxed) brings them inward.
const Hare: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [6, 0, -10], // alert: leans outward; relaxed: inward
      })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({
        inputRange: [-1, 0, 1],
        outputRange: [-6, 0, 10],
      })
    : 0;
  return (
    <>
      {/* left ear: rotate around its base (x=38.5, y=44). */}
      <AnimatedG originX={38.5} originY={44} rotation={leftEarRot}>
        <Rect x={33} y={6} width={11} height={38} rx={5} fill={BONE} />
        <Rect x={36} y={12} width={5} height={26} rx={2} fill={BRASS} />
      </AnimatedG>
      <AnimatedG originX={61.5} originY={44} rotation={rightEarRot}>
        <Rect x={56} y={6} width={11} height={38} rx={5} fill={BONE} />
        <Rect x={59} y={12} width={5} height={26} rx={2} fill={BRASS} />
      </AnimatedG>
      {/* head */}
      <Ellipse cx={50} cy={60} rx={28} ry={26} fill={BONE} />
      <Eyes
        leftPivot={{ x: 38, y: 56 }}
        rightPivot={{ x: 62, y: 56 }}
        scale={eyeScale}
      >
        <Circle cx={38} cy={56} r={2.8} fill={INK} />
        <Circle cx={62} cy={56} r={2.8} fill={INK} />
      </Eyes>
      <Mouth pivot={{ x: 50, y: 68 }} scale={mouthScale} axis="y">
        <Ellipse cx={50} cy={68} rx={3.5} ry={2.5} fill={INK} />
      </Mouth>
    </>
  );
};

// Stag signature: head lift on expressiveness. Animated speakers
// raise the stag's whole head + antlers (proud, alert pose); flat
// speakers leave it neutral. The expressiveness signal already
// encodes "voice variation," which maps cleanly to "stand tall."
const Stag: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const translateY = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -3] })
    : 0;
  return (
    <AnimatedG translateY={translateY}>
      {/* antlers — exception to the no-stroke rule per design notes */}
      <Path
        d="M30,28 L24,12 M30,28 L18,22 M30,28 L34,8"
        stroke={BRASS}
        strokeWidth={3}
        fill="none"
        strokeLinecap="square"
      />
      <Path
        d="M70,28 L76,12 M70,28 L82,22 M70,28 L66,8"
        stroke={BRASS}
        strokeWidth={3}
        fill="none"
        strokeLinecap="square"
      />
      {/* head */}
      <Path d="M30,30 L70,30 L66,68 L50,88 L34,68 Z" fill={BRASS} />
      {/* white chin */}
      <Path d="M42,62 L58,62 L50,84 Z" fill={BONE} />
      <Eyes
        leftPivot={{ x: 40, y: 46 }}
        rightPivot={{ x: 60, y: 46 }}
        scale={eyeScale}
      >
        <Ellipse cx={40} cy={46} rx={2.6} ry={2.6} fill={INK} />
        <Ellipse cx={60} cy={46} rx={2.6} ry={2.6} fill={INK} />
      </Eyes>
      <Mouth pivot={{ x: 50, y: 64 }} scale={mouthScale} axis="y">
        <Ellipse cx={50} cy={64} rx={3} ry={2} fill={INK} />
      </Mouth>
    </AnimatedG>
  );
};

// Whale signature: gentle body roll on expressiveness. A profile pose
// with limited animation surface — the whole body tilts ±2° from
// horizontal as the speaker becomes more animated.
const Whale: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const rotation = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, 2] })
    : 0;
  return (
    <AnimatedG originX={50} originY={55} rotation={rotation}>
      <Path
        d="M10,55 Q15,38 40,38 Q70,38 78,52 L94,42 L88,58 L94,68 L78,60 Q70,72 40,72 Q15,72 10,55 Z"
        fill={INK}
      />
      <Path d="M22,58 Q40,68 65,64 L65,62 Q40,56 22,52 Z" fill={BONE} />
      <Eyes
        leftPivot={{ x: 68, y: 50 }}
        rightPivot={{ x: 68, y: 50 }}
        scale={eyeScale}
      >
        <Circle cx={68} cy={50} r={2} fill={BRASS} />
        <G />
      </Eyes>
      {/* No visible mouth element — `mouthScale` consumed but not
          rendered. AvatarRenderer still drives the value; we just don't
          wire it. Keeps the animal shape stable when the mouth amplitude
          signal lights up. */}
      <Mouth pivot={{ x: 50, y: 55 }} scale={mouthScale} axis="x">
        <G />
      </Mouth>
    </AnimatedG>
  );
};

// Moth signature: wing splay on activity. Each wing rotates outward
// from the body center — fast articulation flares the wings open,
// monotone or silence brings them back to rest.
const Moth: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const leftWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -8] })
    : 0;
  const rightWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 8] })
    : 0;
  return (
    <>
      <Path d="M46,18 Q40,8 32,6" stroke={INK} strokeWidth={1.5} fill="none" />
      <Path d="M54,18 Q60,8 68,6" stroke={INK} strokeWidth={1.5} fill="none" />
      {/* left wings — upper + lower share the same pivot at body center */}
      <AnimatedG originX={50} originY={50} rotation={leftWingRot}>
        <Path d="M50,28 L18,22 L10,42 L50,52 Z" fill={BRASS} />
        <Path d="M50,52 L20,52 L28,76 L50,68 Z" fill={BONE} />
      </AnimatedG>
      {/* right wings — mirrored rotation */}
      <AnimatedG originX={50} originY={50} rotation={rightWingRot}>
        <Path d="M50,28 L82,22 L90,42 L50,52 Z" fill={BRASS} />
        <Path d="M50,52 L80,52 L72,76 L50,68 Z" fill={BONE} />
      </AnimatedG>
      <Mouth pivot={{ x: 50, y: 48 }} scale={mouthScale} axis="y">
        <Ellipse cx={50} cy={48} rx={4} ry={22} fill={INK} />
      </Mouth>
      <Eyes
        leftPivot={{ x: 28, y: 36 }}
        rightPivot={{ x: 72, y: 36 }}
        scale={eyeScale}
      >
        <Circle cx={28} cy={36} r={3} fill={INK} />
        <Circle cx={72} cy={36} r={3} fill={INK} />
      </Eyes>
    </>
  );
};

// Octopus signature: tentacle sway on expressiveness. The 6 tentacles
// rotate slightly around the mantle base — animated speech sways
// them outward, monotone leaves them hanging straight.
const Octopus: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  // Hoisted to consts so we don't allocate fresh AnimatedInterpolation
  // nodes on every render (this hook fires ~30 Hz under Private Call).
  const swayLeft = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, 8] })
    : 0;
  const swayRight = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -8] })
    : 0;
  return (
    <>
      {/* mantle */}
      <Path
        d="M22,42 Q22,18 50,18 Q78,18 78,42 L78,58 Q78,62 74,62 L26,62 Q22,62 22,58 Z"
        fill={BRASS}
      />
      {/* tentacles — sway outward from the mantle's bottom center */}
      <AnimatedG originX={50} originY={62} rotation={swayLeft}>
        <Path d="M26,62 Q20,75 28,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M36,62 Q32,80 42,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M46,62 L44,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
      </AnimatedG>
      <AnimatedG originX={50} originY={62} rotation={swayRight}>
        <Path d="M54,62 L56,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M64,62 Q68,80 58,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M74,62 Q80,75 72,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
      </AnimatedG>
      <Eyes
        leftPivot={{ x: 40, y: 40 }}
        rightPivot={{ x: 60, y: 40 }}
        scale={eyeScale}
      >
        <Circle cx={40} cy={40} r={3.5} fill={INK} />
        <Circle cx={60} cy={40} r={3.5} fill={INK} />
      </Eyes>
      {/* No mouth — octopus mouth is hidden under the mantle. Same trick
          as whale: consume the signal silently. */}
      <Mouth pivot={{ x: 50, y: 50 }} scale={mouthScale} axis="y">
        <G />
      </Mouth>
    </>
  );
};

// Heron signature: head + neck sway on pitchTrend. Rising pitch
// pulls the head forward (lean-in), falling pitch pulls back.
// Only the head + tip of the neck moves — body + legs stay rooted.
const Heron: AnimalRender = ({ eyeScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const translateX = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-2, 0, 3] })
    : 0;
  return (
    <>
      {/* body */}
      <Ellipse cx={60} cy={72} rx={22} ry={14} fill={BONE} />
      {/* neck S-curve */}
      <Path d="M58,62 Q40,52 44,32 Q48,18 60,16" stroke={BONE} strokeWidth={8} fill="none" strokeLinecap="round" />
      <AnimatedG translateX={translateX}>
        {/* head */}
        <Ellipse cx={62} cy={16} rx={8} ry={7} fill={BONE} />
        <Eyes
          leftPivot={{ x: 60, y: 14 }}
          rightPivot={{ x: 60, y: 14 }}
          scale={eyeScale}
        >
          <Circle cx={60} cy={14} r={1.6} fill={INK} />
          <G />
        </Eyes>
        {/* Beak is the mouth. Switched from BRASS fill (invisible
            against the BONE+BRASS body) to INK stroke so it actually
            reads. Closed: upper + lower mandible meeting at the tip.
            Open: mandibles spread, beak gapes. Same path structure
            (M L L Z) so the morph reads as a beak opening, not a
            shape replacement. */}
        <MouthMorph
          closedD="M 68 16 L 92 17 L 68 18 Z"
          openD="M 68 14 L 92 17 L 68 20 Z"
          openness={prosody?.mouthShape ?? 0}
          stroke={INK}
          strokeWidth={1.1}
        />
      </AnimatedG>
      {/* legs */}
      <Line x1={54} y1={84} x2={50} y2={96} stroke={BRASS} strokeWidth={2} />
      <Line x1={66} y1={84} x2={70} y2={96} stroke={BRASS} strokeWidth={2} />
    </>
  );
};

// Bear signature: head tilt on pitchTrend. Bears tilt their heads
// when curious; rising pitch tilts right, falling tilts left.
const Bear: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const rotation = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-5, 0, 5] })
    : 0;
  return (
    <AnimatedG originX={50} originY={50} rotation={rotation}>
      {/* ears */}
      <Circle cx={26} cy={24} r={10} fill={INK} />
      <Circle cx={74} cy={24} r={10} fill={INK} />
      <Circle cx={26} cy={24} r={4} fill={BRASS} />
      <Circle cx={74} cy={24} r={4} fill={BRASS} />
      {/* head */}
      <Ellipse cx={50} cy={56} rx={32} ry={30} fill={INK} />
      {/* snout — the audio-driven element. Translates downward as the
          jaw drops, per spec §3.3 (`translateMaxPx > 0` for bear). The
          AvatarRenderer doesn't yet wire the translate channel; treat
          this as scale-only for MVP. */}
      <Mouth pivot={{ x: 50, y: 68 }} scale={mouthScale} axis="y">
        <G>
          <Ellipse cx={50} cy={68} rx={14} ry={10} fill={BONE} />
          <Ellipse cx={50} cy={64} rx={3.5} ry={2.5} fill={INK} />
        </G>
      </Mouth>
      <Eyes
        leftPivot={{ x: 38, y: 50 }}
        rightPivot={{ x: 62, y: 50 }}
        scale={eyeScale}
      >
        <Circle cx={38} cy={50} r={2.8} fill={BRASS} />
        <Circle cx={62} cy={50} r={2.8} fill={BRASS} />
      </Eyes>
    </AnimatedG>
  );
};

// Cat signature: ear angle on pitchTrend. Cats rotate their ears
// independently and dramatically — alert speaker (rising pitch)
// rotates ears forward, relaxed (falling) flattens them outward.
const Cat: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [15, 0, -10] })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-15, 0, 10] })
    : 0;
  return (
    <>
      {/* left ear: rotate around base (x=25, y=32). */}
      <AnimatedG originX={25} originY={32} rotation={leftEarRot}>
        <Polygon points="14,32 30,8 36,32" fill={INK} />
        <Polygon points="22,28 30,15 32,28" fill={BRASS} />
      </AnimatedG>
      <AnimatedG originX={75} originY={32} rotation={rightEarRot}>
        <Polygon points="64,32 70,8 86,32" fill={INK} />
        <Polygon points="68,28 70,15 78,28" fill={BRASS} />
      </AnimatedG>
      {/* head */}
      <Ellipse cx={50} cy={56} rx={34} ry={30} fill={INK} />
      <Eyes
        leftPivot={{ x: 36, y: 48 }}
        rightPivot={{ x: 64, y: 48 }}
        scale={eyeScale}
      >
        <G>
          <Path d="M28,48 Q36,42 44,48 Q36,54 28,48 Z" fill={BRASS} />
          <Ellipse cx={36} cy={48} rx={1.5} ry={3} fill={INK} />
        </G>
        <G>
          <Path d="M56,48 Q64,42 72,48 Q64,54 56,48 Z" fill={BRASS} />
          <Ellipse cx={64} cy={48} rx={1.5} ry={3} fill={INK} />
        </G>
      </Eyes>
      <Mouth pivot={{ x: 50, y: 65 }} scale={mouthScale} axis="y">
        <Polygon points="46,62 54,62 50,68" fill={BRASS} />
      </Mouth>
    </>
  );
};

// Bat signature: wing flutter on activity. The angular wings tilt
// from the body center — fast articulation rotates them upward
// (mid-flap), monotone or silence settles them outward (gliding).
const Bat: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const leftWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 14] })
    : 0;
  const rightWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -14] })
    : 0;
  return (
    <>
      {/* left wing — pivot at body center where wing meets torso */}
      <AnimatedG originX={50} originY={50} rotation={leftWingRot}>
        <Path d="M50,46 L20,30 L8,42 L18,46 L8,54 L24,58 L50,52 Z" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={50} originY={50} rotation={rightWingRot}>
        <Path d="M50,46 L80,30 L92,42 L82,46 L92,54 L76,58 L50,52 Z" fill={INK} />
      </AnimatedG>
      {/* head */}
      <Ellipse cx={50} cy={52} rx={14} ry={13} fill={INK} />
      <Polygon points="40,38 46,28 48,40" fill={INK} />
      <Polygon points="52,40 54,28 60,38" fill={INK} />
      <Eyes
        leftPivot={{ x: 44, y: 50 }}
        rightPivot={{ x: 56, y: 50 }}
        scale={eyeScale}
      >
        <Circle cx={44} cy={50} r={2} fill={BRASS} />
        <Circle cx={56} cy={50} r={2} fill={BRASS} />
      </Eyes>
      <Mouth pivot={{ x: 50, y: 60 }} scale={mouthScale} axis="y">
        <G>
          <Polygon points="46,58 48,64 50,58" fill={BONE} />
          <Polygon points="50,58 52,64 54,58" fill={BONE} />
        </G>
      </Mouth>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────
// rc.12 — call-mask Render variants.
//
// Each free common gets a second Render used ONLY when the avatar
// receives a `prosody` prop (i.e. during a Private/Audio/Video
// call). Versus the minimalist default Renders above, the call masks:
//
//   - keep BRASS/BONE/INK palette and 100×100 viewBox
//   - keep the animal's identity cues (ears, antlers, beak, wings)
//   - amplify the face: eyes 2-4× larger, posable mouth, optional
//     eyebrows on `expressiveness`, optional cheek tint on `activity`
//   - consume the same rc.11 prosody channels (mouthShape, pitchTrend,
//     expressiveness, activity) — no new wire-format work
//
// 4 animals are RE-POSED (default profile pose unsuitable for face
// expression): pigeon, whale, moth, heron. Their call masks pivot to
// frontal or ¾ portrait. The other 8 stay in their default frontal
// pose with amplified features.
//
// Default Renders above remain unchanged — used in chat row avatars,
// picker grids, AppBar, IdReveal previews, and notification thumbnail
// rasterization. Brand identity in static contexts preserved.

const FoxCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const activitySrc = prosody?.activity;
  const shapeSrc = prosody?.mouthShape;

  const leftEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [12, 0, -6] })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-12, 0, 6] })
    : 0;
  const browScale = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.25] })
    : 1;
  const cheekOpacity = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 0.4] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.2] })
    : 1;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      <AnimatedG originX={28} originY={30} rotation={leftEarRot}>
        <Polygon points="18,8 38,8 28,32" fill={BRASS} />
        <Polygon points="24,16 32,16 28,28" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={72} originY={30} rotation={rightEarRot}>
        <Polygon points="62,8 82,8 72,32" fill={BRASS} />
        <Polygon points="68,16 76,16 72,28" fill={INK} />
      </AnimatedG>
      <Path d="M16,28 L84,28 L78,64 L50,92 L22,64 Z" fill={BRASS} />
      <Path d="M36,58 L64,58 L50,90 Z" fill={BONE} />

      <AnimatedG opacity={cheekOpacity}>
        <Ellipse cx={28} cy={56} rx={6} ry={3} fill={BRASS} />
        <Ellipse cx={72} cy={56} rx={6} ry={3} fill={BRASS} />
      </AnimatedG>

      <AnimatedG originX={34} originY={36} scaleY={browScale}>
        <Polygon points="26,36 42,33 42,38 26,40" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={66} originY={36} scaleY={browScale}>
        <Polygon points="58,33 74,36 74,40 58,38" fill={INK} />
      </AnimatedG>

      <ExprEyes leftCx={34} rightCx={66} cy={48} r={8} blink={eyeScale} prosody={prosody} />

      <AnimatedG originX={50} originY={70} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 70 }} scale={mouthScale} axis="y">
          <Path d="M40,68 Q50,76 60,68 L57,72 Q50,76 43,72 Z" fill={INK} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
  );
};

const OwlCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const activitySrc = prosody?.activity;
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -2] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.15] })
    : 1;
  // Owls swivel — tilt the whole head on pitch trend.
  const headTilt = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [9, 0, -9] })
    : 0;
  // Ear tufts perk up and fan with articulation rate (activity channel).
  const leftTuftRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -12] })
    : 0;
  const rightTuftRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 12] })
    : 0;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
    <AnimatedG originX={50} originY={50} rotation={headTilt}>
      <AnimatedG originX={27} originY={18} rotation={leftTuftRot}>
        <Polygon points="20,18 32,18 27,5" fill={BRASS} />
      </AnimatedG>
      <AnimatedG originX={73} originY={18} rotation={rightTuftRot}>
        <Polygon points="68,18 80,18 73,5" fill={BRASS} />
      </AnimatedG>
      <Path
        d="M18,22 Q18,18 30,18 L70,18 Q82,18 82,22 L82,76 Q82,90 50,90 Q18,90 18,76 Z"
        fill={BRASS}
      />
      <Ellipse cx={50} cy={46} rx={32} ry={28} fill={BONE} />

      {/* Brow furrow — small wedges above each eye, drift up on expressiveness */}
      <AnimatedG translateY={browDy}>
        <Polygon points="26,30 44,28 44,32 26,34" fill={INK} />
        <Polygon points="56,28 74,30 74,34 56,32" fill={INK} />
      </AnimatedG>

      <ExprEyes leftCx={36} rightCx={64} cy={46} r={11} blink={eyeScale} prosody={prosody} />

      {/* Beak — bigger downward triangle, X-scale on mouthShape */}
      <AnimatedG originX={50} originY={62} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 62 }} scale={mouthScale} axis="y">
          <Polygon points="42,60 58,60 50,72" fill={BRASS} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
    </AnimatedG>
  );
};

const PigeonCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const bodyDy = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -3] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.2] })
    : 1;
  // Pigeons bob — tilt the whole head on pitch trend.
  const headTilt = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [8, 0, -8] })
    : 0;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
    <AnimatedG translateY={bodyDy}>
      <AnimatedG originX={50} originY={50} rotation={headTilt}>
        {/* Dome head, both eyes visible (re-pose from profile → ¾) */}
        <Ellipse cx={50} cy={50} rx={32} ry={28} fill={INK} />
        {/* BRASS sheen along the upper head — classic pigeon iridescence cue */}
        <Path d="M22,42 Q50,30 78,42 Q78,46 50,38 Q22,46 22,42 Z" fill={BRASS} opacity={0.35} />

        <ExprEyes leftCx={38} rightCx={62} cy={46} r={5} blink={eyeScale} prosody={prosody} />

        <AnimatedG originX={50} originY={62} scaleX={mouthShapeX}>
          <Mouth pivot={{ x: 50, y: 62 }} scale={mouthScale} axis="y">
            <Polygon points="44,60 56,60 50,68" fill={BRASS} />
          </Mouth>
        </AnimatedG>
      </AnimatedG>
    </AnimatedG>
    </AnimatedG>
  );
};

const HareCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [6, 0, -10] })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-6, 0, 10] })
    : 0;
  const browScale = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.2] })
    : 1;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.2] })
    : 1;
  // Ears twitch — splay sideways with articulation rate (activity channel).
  const activitySrc = prosody?.activity;
  const leftEarTwitch = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -8] })
    : 0;
  const rightEarTwitch = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 8] })
    : 0;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      <AnimatedG originX={38.5} originY={44} rotation={leftEarTwitch}>
        <AnimatedG originX={38.5} originY={44} rotation={leftEarRot}>
          <Rect x={33} y={6} width={11} height={38} rx={5} fill={BONE} />
          <Rect x={36} y={12} width={5} height={26} rx={2} fill={BRASS} />
        </AnimatedG>
      </AnimatedG>
      <AnimatedG originX={61.5} originY={44} rotation={rightEarTwitch}>
        <AnimatedG originX={61.5} originY={44} rotation={rightEarRot}>
          <Rect x={56} y={6} width={11} height={38} rx={5} fill={BONE} />
          <Rect x={59} y={12} width={5} height={26} rx={2} fill={BRASS} />
        </AnimatedG>
      </AnimatedG>
      <Ellipse cx={50} cy={60} rx={30} ry={28} fill={BONE} />

      {/* Subtle eyebrows */}
      <AnimatedG originX={36} originY={50} scaleY={browScale}>
        <Polygon points="28,50 44,48 44,52 28,53" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={64} originY={50} scaleY={browScale}>
        <Polygon points="56,48 72,50 72,53 56,52" fill={INK} />
      </AnimatedG>

      <ExprEyes leftCx={36} rightCx={64} cy={58} r={7} blink={eyeScale} prosody={prosody} />

      <AnimatedG originX={50} originY={74} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 74 }} scale={mouthScale} axis="y">
          <Path d="M44,72 Q50,80 56,72 L54,76 Q50,80 46,76 Z" fill={INK} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
  );
};

const StagCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const activitySrc = prosody?.activity;
  const browScale = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.25] })
    : 1;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.15] })
    : 1;
  // Proud head + antlers tip with the peer's pitch trend.
  const headTilt = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [8, 0, -8] })
    : 0;
  // Cheek patches flush with articulation rate (activity channel).
  const cheekOpacity = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] })
    : 0;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
    <AnimatedG originX={50} originY={60} rotation={headTilt}>
      {/* Antlers — preserved from default */}
      <Path
        d="M30,28 L24,12 M30,28 L18,22 M30,28 L34,8"
        stroke={BRASS}
        strokeWidth={3}
        fill="none"
        strokeLinecap="square"
      />
      <Path
        d="M70,28 L76,12 M70,28 L82,22 M70,28 L66,8"
        stroke={BRASS}
        strokeWidth={3}
        fill="none"
        strokeLinecap="square"
      />
      <Path d="M28,30 L72,30 L66,68 L50,92 L34,68 Z" fill={BRASS} />
      <Path d="M40,62 L60,62 L50,86 Z" fill={BONE} />

      <AnimatedG opacity={cheekOpacity}>
        <Ellipse cx={32} cy={58} rx={5} ry={3} fill={BONE} />
        <Ellipse cx={68} cy={58} rx={5} ry={3} fill={BONE} />
      </AnimatedG>

      <AnimatedG originX={38} originY={40} scaleY={browScale}>
        <Polygon points="30,40 46,38 46,42 30,43" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={62} originY={40} scaleY={browScale}>
        <Polygon points="54,38 70,40 70,43 54,42" fill={INK} />
      </AnimatedG>

      <ExprEyes leftCx={38} rightCx={62} cy={50} r={6} blink={eyeScale} prosody={prosody} />

      <AnimatedG originX={50} originY={70} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 70 }} scale={mouthScale} axis="y">
          <Path d="M42,68 Q50,76 58,68 L55,72 Q50,76 45,72 Z" fill={INK} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
    </AnimatedG>
  );
};

const WhaleCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const activitySrc = prosody?.activity;
  const bodyRot = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, 3] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.15] })
    : 1;
  // Whole head rolls with the peer's pitch trend.
  const headTilt = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [7, 0, -7] })
    : 0;
  // Blowhole spout puffs with articulation rate (activity channel).
  const spoutOpacity = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] })
    : 0;
  // Brow ridge lifts with expressiveness.
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -2] })
    : 0;
  // Whole-body flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
    <AnimatedG originX={50} originY={50} rotation={headTilt}>
      <AnimatedG originX={50} originY={50} rotation={bodyRot}>
        {/* Blowhole spout — puffs with activity */}
        <AnimatedG opacity={spoutOpacity}>
          <Path d="M48,20 Q44,8 40,4" stroke={BONE} strokeWidth={2.5} fill="none" strokeLinecap="round" />
          <Path d="M52,20 Q56,8 60,4" stroke={BONE} strokeWidth={2.5} fill="none" strokeLinecap="round" />
        </AnimatedG>

        {/* Stylized whale head — emerging from below */}
        <Path
          d="M10,40 Q15,20 50,20 Q85,20 90,40 Q90,72 50,80 Q10,72 10,40 Z"
          fill={INK}
        />
        {/* White belly cue */}
        <Path d="M22,52 Q50,68 78,52 Q78,72 50,76 Q22,72 22,52 Z" fill={BONE} />

        {/* Brow ridge — lifts with expressiveness */}
        <AnimatedG translateY={browDy}>
          <Polygon points="28,34 40,32 40,35 28,37" fill={BONE} />
          <Polygon points="60,32 72,34 72,37 60,35" fill={BONE} />
        </AnimatedG>

        <ExprEyes leftCx={36} rightCx={64} cy={42} r={5} blink={eyeScale} prosody={prosody} />

        {/* Wide smile-arc mouth */}
        <AnimatedG originX={50} originY={62} scaleX={mouthShapeX}>
          <Mouth pivot={{ x: 50, y: 62 }} scale={mouthScale} axis="y">
            <Path d="M28,60 Q50,72 72,60 L70,64 Q50,74 30,64 Z" fill={INK} />
          </Mouth>
        </AnimatedG>
      </AnimatedG>
    </AnimatedG>
    </AnimatedG>
  );
};

const MothCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const leftWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -10] })
    : 0;
  const rightWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 10] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.2] })
    : 1;
  // Feathery antennae sweep with the peer's pitch trend.
  const leftAntennaRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [10, 0, -10] })
    : 0;
  const rightAntennaRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-10, 0, 10] })
    : 0;
  // Wings flare wider as the peer's voice gets more animated (expressiveness).
  const wingFlare = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] })
    : 1;
  // Brow lifts with expressiveness.
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -1.5] })
    : 0;
  // Whole-body flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      {/* Antennae — sweep on pitch trend */}
      <AnimatedG originX={44} originY={30} rotation={leftAntennaRot}>
        <Path d="M44,30 Q38,18 30,14" stroke={INK} strokeWidth={1.5} fill="none" />
      </AnimatedG>
      <AnimatedG originX={56} originY={30} rotation={rightAntennaRot}>
        <Path d="M56,30 Q62,18 70,14" stroke={INK} strokeWidth={1.5} fill="none" />
      </AnimatedG>

      {/* Wings — rotated back from face center, expose real face; flare on expressiveness */}
      <AnimatedG originX={50} originY={50} scale={wingFlare}>
        <AnimatedG originX={50} originY={50} rotation={leftWingRot}>
          <Path d="M44,40 L14,30 L8,52 L44,62 Z" fill={BRASS} />
          <Path d="M44,62 L18,68 L26,84 L44,76 Z" fill={BONE} />
        </AnimatedG>
        <AnimatedG originX={50} originY={50} rotation={rightWingRot}>
          <Path d="M56,40 L86,30 L92,52 L56,62 Z" fill={BRASS} />
          <Path d="M56,62 L82,68 L74,84 L56,76 Z" fill={BONE} />
        </AnimatedG>
      </AnimatedG>

      {/* Centered body + face */}
      <Ellipse cx={50} cy={56} rx={8} ry={20} fill={INK} />

      {/* Brow — tiny wedges lift with expressiveness */}
      <AnimatedG translateY={browDy}>
        <Polygon points="41,39 47,38 47,40 41,41" fill={INK} />
        <Polygon points="53,38 59,39 59,41 53,40" fill={INK} />
      </AnimatedG>

      <ExprEyes leftCx={45} rightCx={55} cy={44} r={3.5} blink={eyeScale} prosody={prosody} />

      <AnimatedG originX={50} originY={56} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 56 }} scale={mouthScale} axis="y">
          <Ellipse cx={50} cy={56} rx={3} ry={2} fill={BONE} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
  );
};

const OctopusCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const activitySrc = prosody?.activity;
  const swayLeft = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, 8] })
    : 0;
  const swayRight = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -8] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.15] })
    : 1;
  // Soft-bodied mantle leans with the peer's pitch trend — rising vs falling pitch tips the head.
  const mantleTilt = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [10, 0, -10] })
    : 0;
  // Articulation rate flushes the cheek patches — pulses with activity.
  const cheekOpacity = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] })
    : 0;
  // Whole-body flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      {/* Tentacles stay anchored to the canvas; only the mantle/head tilts on pitch. */}
      <AnimatedG originX={50} originY={62} rotation={swayLeft}>
        <Path d="M22,62 Q16,75 26,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M34,62 Q30,80 42,92" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M46,62 L44,94" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
      </AnimatedG>
      <AnimatedG originX={50} originY={62} rotation={swayRight}>
        <Path d="M54,62 L56,94" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M66,62 Q70,80 58,92" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
        <Path d="M78,62 Q84,75 74,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
      </AnimatedG>

      <AnimatedG originX={50} originY={48} rotation={mantleTilt}>
        {/* Larger mantle for call view */}
        <Path
          d="M16,38 Q16,14 50,14 Q84,14 84,38 L84,58 Q84,62 80,62 L20,62 Q16,62 16,58 Z"
          fill={BRASS}
        />

        {/* Cheek flush — pulses with articulation rate (activity channel) */}
        <AnimatedG opacity={cheekOpacity}>
          <Ellipse cx={30} cy={46} rx={6} ry={4} fill={INK} />
          <Ellipse cx={70} cy={46} rx={6} ry={4} fill={INK} />
        </AnimatedG>

        <ExprEyes leftCx={38} rightCx={62} cy={36} r={6} blink={eyeScale} prosody={prosody} />

        {/* Mouth — small smile on the mantle */}
        <AnimatedG originX={50} originY={50} scaleX={mouthShapeX}>
          <Mouth pivot={{ x: 50, y: 50 }} scale={mouthScale} axis="y">
            <Path d="M42,48 Q50,54 58,48 L56,52 Q50,55 44,52 Z" fill={INK} />
          </Mouth>
        </AnimatedG>
      </AnimatedG>
    </AnimatedG>
  );
};

const HeronCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const activitySrc = prosody?.activity;
  const headTx = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-3, 0, 4] })
    : 0;
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -3] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.3] })
    : 1;
  // Nuchal crest plume raises with articulation rate (activity channel).
  const crestRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -22] })
    : 0;
  // Whole-figure flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      {/* Body — smaller, bottom-left; keeps the heron silhouette */}
      <Ellipse cx={32} cy={84} rx={12} ry={7} fill={BONE} />
      {/* Neck — shorter; still an S-curve cue */}
      <Path d="M36,78 Q44,62 50,46" stroke={BONE} strokeWidth={9} fill="none" strokeLinecap="round" />

      <AnimatedG translateX={headTx}>
        {/* Nuchal crest — trailing plume off the back of the head, lifts on activity */}
        <AnimatedG originX={70} originY={20} rotation={crestRot}>
          <Path d="M70,20 Q84,14 92,8" stroke={BONE} strokeWidth={3} fill="none" strokeLinecap="round" />
          <Path d="M70,22 Q86,18 95,14" stroke={BONE} strokeWidth={3} fill="none" strokeLinecap="round" />
        </AnimatedG>

        {/* Enlarged head — ¾ portrait, two visible eyes */}
        <Ellipse cx={56} cy={36} rx={28} ry={26} fill={BONE} />

        <AnimatedG translateY={browDy}>
          <Polygon points="40,22 54,18 54,22 40,26" fill={INK} />
          <Polygon points="62,18 76,22 76,26 62,22" fill={INK} />
        </AnimatedG>

        <ExprEyes leftCx={46} rightCx={66} cy={36} r={6} blink={eyeScale} prosody={prosody} />

        {/* Beak repositioned below the face */}
        <AnimatedG originX={56} originY={56} scaleX={mouthShapeX}>
          <Mouth pivot={{ x: 56, y: 56 }} scale={mouthScale} axis="y">
            <Path d="M44,52 L68,54 L56,64 Z" fill={BRASS} />
          </Mouth>
        </AnimatedG>
      </AnimatedG>
    </AnimatedG>
  );
};

const BearCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const shapeSrc = prosody?.mouthShape;
  const activitySrc = prosody?.activity;
  const headRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-5, 0, 5] })
    : 0;
  const browScale = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.25] })
    : 1;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.15] })
    : 1;
  // Rounded ears perk with articulation rate (activity channel).
  const earPerk = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [1, 1.2] })
    : 1;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
    <AnimatedG originX={50} originY={50} rotation={headRot}>
      <AnimatedG originX={26} originY={24} scale={earPerk}>
        <Circle cx={26} cy={24} r={11} fill={INK} />
        <Circle cx={26} cy={24} r={5} fill={BRASS} />
      </AnimatedG>
      <AnimatedG originX={74} originY={24} scale={earPerk}>
        <Circle cx={74} cy={24} r={11} fill={INK} />
        <Circle cx={74} cy={24} r={5} fill={BRASS} />
      </AnimatedG>
      <Ellipse cx={50} cy={56} rx={34} ry={32} fill={INK} />

      <AnimatedG originX={38} originY={44} scaleY={browScale}>
        <Polygon points="30,44 46,42 46,46 30,47" fill={BONE} />
      </AnimatedG>
      <AnimatedG originX={62} originY={44} scaleY={browScale}>
        <Polygon points="54,42 70,44 70,47 54,46" fill={BONE} />
      </AnimatedG>

      <ExprEyes leftCx={38} rightCx={62} cy={52} r={7} blink={eyeScale} prosody={prosody} />

      {/* Snout — BONE muzzle with INK posable mouth */}
      <Ellipse cx={50} cy={70} rx={16} ry={11} fill={BONE} />
      <AnimatedG originX={50} originY={72} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 72 }} scale={mouthScale} axis="y">
          <Path d="M42,70 Q50,78 58,70 L55,74 Q50,78 45,74 Z" fill={INK} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
    </AnimatedG>
  );
};

const CatCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const trendSrc = prosody?.pitchTrend;
  const activitySrc = prosody?.activity;
  const shapeSrc = prosody?.mouthShape;
  const exprSrc = prosody?.expressiveness;
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [15, 0, -10] })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-15, 0, 10] })
    : 0;
  const whiskerSpread = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] })
    : 1;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1.15] })
    : 1;
  // Ears perk taller as the peer's voice gets more animated (expressiveness).
  const earPerk = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.2] })
    : 1;
  // Brow lifts with expressiveness.
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -2] })
    : 0;
  // Whole-head flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      <AnimatedG originX={25} originY={32} scaleY={earPerk}>
        <AnimatedG originX={25} originY={32} rotation={leftEarRot}>
          <Polygon points="14,32 30,8 36,32" fill={INK} />
          <Polygon points="22,28 30,15 32,28" fill={BRASS} />
        </AnimatedG>
      </AnimatedG>
      <AnimatedG originX={75} originY={32} scaleY={earPerk}>
        <AnimatedG originX={75} originY={32} rotation={rightEarRot}>
          <Polygon points="64,32 70,8 86,32" fill={INK} />
          <Polygon points="68,28 70,15 78,28" fill={BRASS} />
        </AnimatedG>
      </AnimatedG>
      <Ellipse cx={50} cy={56} rx={36} ry={32} fill={INK} />

      {/* Brow — lifts with expressiveness */}
      <AnimatedG translateY={browDy}>
        <Polygon points="28,42 44,40 44,43 28,44" fill={BONE} />
        <Polygon points="56,40 72,42 72,44 56,43" fill={BONE} />
      </AnimatedG>

      <ExprEyes leftCx={36} rightCx={64} cy={50} r={8} blink={eyeScale} prosody={prosody} />

      {/* Whiskers — splay outward on activity */}
      <AnimatedG originX={50} originY={68} scaleX={whiskerSpread}>
        <Line x1={20} y1={66} x2={42} y2={68} stroke={BONE} strokeWidth={0.6} />
        <Line x1={20} y1={70} x2={42} y2={70} stroke={BONE} strokeWidth={0.6} />
        <Line x1={58} y1={68} x2={80} y2={66} stroke={BONE} strokeWidth={0.6} />
        <Line x1={58} y1={70} x2={80} y2={70} stroke={BONE} strokeWidth={0.6} />
      </AnimatedG>

      {/* Pink nose + posable mouth */}
      <Polygon points="47,64 53,64 50,68" fill={BRASS} />
      <AnimatedG originX={50} originY={74} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 74 }} scale={mouthScale} axis="y">
          <Path d="M42,72 Q50,78 58,72 L55,75 Q50,78 45,75 Z" fill={BRASS} />
        </Mouth>
      </AnimatedG>
    </AnimatedG>
  );
};

const BatCall: AnimalRender = ({ eyeScale, mouthScale, prosody }) => {
  const activitySrc = prosody?.activity;
  const shapeSrc = prosody?.mouthShape;
  const trendSrc = prosody?.pitchTrend;
  const exprSrc = prosody?.expressiveness;
  const leftWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, 14] })
    : 0;
  const rightWingRot = activitySrc
    ? activitySrc.interpolate({ inputRange: [0, 1], outputRange: [0, -14] })
    : 0;
  const mouthShapeX = shapeSrc
    ? shapeSrc.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.2] })
    : 1;
  // Big ears swivel with the peer's pitch trend.
  const leftEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [10, 0, -10] })
    : 0;
  const rightEarRot = trendSrc
    ? trendSrc.interpolate({ inputRange: [-1, 0, 1], outputRange: [-10, 0, 10] })
    : 0;
  // Ears perk taller as the peer's voice gets more animated (expressiveness).
  const earPerk = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.25] })
    : 1;
  // Brow lifts with expressiveness.
  const browDy = exprSrc
    ? exprSrc.interpolate({ inputRange: [0, 1], outputRange: [0, -1.5] })
    : 0;
  // Whole-body flinch: brace back only at a real shout (amplitude > ~0.6).
  const ampSrc = prosody?.amplitude;
  const recoil = ampSrc
    ? ampSrc.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, -9] })
    : 0;

  return (
    <AnimatedG translateY={recoil}>
      <AnimatedG originX={50} originY={50} rotation={leftWingRot}>
        <Path d="M50,46 L20,28 L6,40 L18,46 L6,54 L24,58 L50,52 Z" fill={INK} />
      </AnimatedG>
      <AnimatedG originX={50} originY={50} rotation={rightWingRot}>
        <Path d="M50,46 L80,28 L94,40 L82,46 L94,54 L76,58 L50,52 Z" fill={INK} />
      </AnimatedG>

      <Ellipse cx={50} cy={52} rx={18} ry={17} fill={INK} />
      <AnimatedG originX={44} originY={40} rotation={leftEarRot}>
        <AnimatedG originX={44} originY={40} scaleY={earPerk}>
          <Polygon points="40,36 46,24 48,40" fill={INK} />
        </AnimatedG>
      </AnimatedG>
      <AnimatedG originX={56} originY={40} rotation={rightEarRot}>
        <AnimatedG originX={56} originY={40} scaleY={earPerk}>
          <Polygon points="52,40 54,24 60,36" fill={INK} />
        </AnimatedG>
      </AnimatedG>

      {/* Brow — lifts with expressiveness */}
      <AnimatedG translateY={browDy}>
        <Polygon points="38,44 47,43 47,45 38,46" fill={BRASS} />
        <Polygon points="53,43 62,44 62,46 53,45" fill={BRASS} />
      </AnimatedG>

      <ExprEyes leftCx={43} rightCx={57} cy={50} r={5} blink={eyeScale} prosody={prosody} />

      {/* Posable mouth with fangs */}
      <AnimatedG originX={50} originY={62} scaleX={mouthShapeX}>
        <Mouth pivot={{ x: 50, y: 62 }} scale={mouthScale} axis="y">
          <G>
            <Path d="M42,60 Q50,68 58,60 L56,63 Q50,68 44,63 Z" fill={BONE} opacity={0.4} />
            <Polygon points="46,60 48,66 50,60" fill={BONE} />
            <Polygon points="50,60 52,66 54,60" fill={BONE} />
          </G>
        </Mouth>
      </AnimatedG>
    </AnimatedG>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Registry. Per-animal `meta` stays adjacent to its `Render` so a
// future swap for illustrator artwork only touches one block per
// animal.

export const ANIMALS: Record<string, AnimalDef> = {
  fox: {
    meta: {
      id: 'fox',
      name: 'Fox',
      anchors: {
        breathePivot: { x: 50, y: 88 },
        eyeLeftPivot: { x: 36, y: 44 },
        eyeRightPivot: { x: 64, y: 44 },
        mouthPivot: { x: 50, y: 60 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 92 },
        eyeLeftPivot: { x: 34, y: 48 },
        eyeRightPivot: { x: 66, y: 48 },
        mouthPivot: { x: 50, y: 70 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 2 },
    },
    Render: Fox,
    RenderCall: FoxCall,
  },
  owl: {
    meta: {
      id: 'owl',
      name: 'Owl',
      anchors: {
        breathePivot: { x: 50, y: 90 },
        eyeLeftPivot: { x: 38, y: 44 },
        eyeRightPivot: { x: 62, y: 44 },
        mouthPivot: { x: 50, y: 54 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 90 },
        eyeLeftPivot: { x: 36, y: 46 },
        eyeRightPivot: { x: 64, y: 46 },
        mouthPivot: { x: 50, y: 62 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.14, translateMaxPx: 0 },
    },
    Render: Owl,
    RenderCall: OwlCall,
  },
  pigeon: {
    meta: {
      id: 'pigeon',
      name: 'Pigeon',
      anchors: {
        breathePivot: { x: 50, y: 76 },
        eyeLeftPivot: { x: 38, y: 44 },
        eyeRightPivot: { x: 38, y: 44 },
        mouthPivot: { x: 70, y: 52 },
        mouthAxis: 'x',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 78 },
        eyeLeftPivot: { x: 38, y: 46 },
        eyeRightPivot: { x: 62, y: 46 },
        mouthPivot: { x: 50, y: 62 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.22, translateMaxPx: 0 },
    },
    Render: Pigeon,
    RenderCall: PigeonCall,
  },
  hare: {
    meta: {
      id: 'hare',
      name: 'Hare',
      anchors: {
        breathePivot: { x: 50, y: 86 },
        eyeLeftPivot: { x: 38, y: 56 },
        eyeRightPivot: { x: 62, y: 56 },
        mouthPivot: { x: 50, y: 68 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 88 },
        eyeLeftPivot: { x: 36, y: 58 },
        eyeRightPivot: { x: 64, y: 58 },
        mouthPivot: { x: 50, y: 74 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 0 },
    },
    Render: Hare,
    RenderCall: HareCall,
  },
  stag: {
    meta: {
      id: 'stag',
      name: 'Stag',
      anchors: {
        breathePivot: { x: 50, y: 88 },
        eyeLeftPivot: { x: 40, y: 46 },
        eyeRightPivot: { x: 60, y: 46 },
        mouthPivot: { x: 50, y: 64 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 92 },
        eyeLeftPivot: { x: 38, y: 50 },
        eyeRightPivot: { x: 62, y: 50 },
        mouthPivot: { x: 50, y: 70 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.16, translateMaxPx: 0 },
    },
    Render: Stag,
    RenderCall: StagCall,
  },
  whale: {
    meta: {
      id: 'whale',
      name: 'Whale',
      anchors: {
        breathePivot: { x: 50, y: 72 },
        eyeLeftPivot: { x: 68, y: 50 },
        eyeRightPivot: { x: 68, y: 50 },
        mouthPivot: { x: 50, y: 55 },
        mouthAxis: 'x',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 80 },
        eyeLeftPivot: { x: 36, y: 42 },
        eyeRightPivot: { x: 64, y: 42 },
        mouthPivot: { x: 50, y: 62 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.06, translateMaxPx: 0 },
    },
    Render: Whale,
    RenderCall: WhaleCall,
  },
  moth: {
    meta: {
      id: 'moth',
      name: 'Moth',
      anchors: {
        breathePivot: { x: 50, y: 76 },
        eyeLeftPivot: { x: 28, y: 36 },
        eyeRightPivot: { x: 72, y: 36 },
        mouthPivot: { x: 50, y: 48 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 76 },
        eyeLeftPivot: { x: 45, y: 44 },
        eyeRightPivot: { x: 55, y: 44 },
        mouthPivot: { x: 50, y: 56 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.06, translateMaxPx: 0 },
    },
    Render: Moth,
    RenderCall: MothCall,
  },
  octopus: {
    meta: {
      id: 'octopus',
      name: 'Octopus',
      anchors: {
        breathePivot: { x: 50, y: 90 },
        eyeLeftPivot: { x: 40, y: 40 },
        eyeRightPivot: { x: 60, y: 40 },
        mouthPivot: { x: 50, y: 50 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 94 },
        eyeLeftPivot: { x: 38, y: 36 },
        eyeRightPivot: { x: 62, y: 36 },
        mouthPivot: { x: 50, y: 50 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.0, translateMaxPx: 0 },
    },
    Render: Octopus,
    RenderCall: OctopusCall,
  },
  heron: {
    meta: {
      id: 'heron',
      name: 'Heron',
      anchors: {
        breathePivot: { x: 60, y: 86 },
        eyeLeftPivot: { x: 60, y: 14 },
        eyeRightPivot: { x: 60, y: 14 },
        mouthPivot: { x: 80, y: 16 },
        mouthAxis: 'x',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 90 },
        eyeLeftPivot: { x: 46, y: 36 },
        eyeRightPivot: { x: 66, y: 36 },
        mouthPivot: { x: 56, y: 56 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.2, translateMaxPx: 0 },
    },
    Render: Heron,
    RenderCall: HeronCall,
  },
  bear: {
    meta: {
      id: 'bear',
      name: 'Bear',
      anchors: {
        breathePivot: { x: 50, y: 86 },
        eyeLeftPivot: { x: 38, y: 50 },
        eyeRightPivot: { x: 62, y: 50 },
        mouthPivot: { x: 50, y: 68 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 88 },
        eyeLeftPivot: { x: 38, y: 52 },
        eyeRightPivot: { x: 62, y: 52 },
        mouthPivot: { x: 50, y: 72 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 3 },
    },
    Render: Bear,
    RenderCall: BearCall,
  },
  cat: {
    meta: {
      id: 'cat',
      name: 'Cat',
      anchors: {
        breathePivot: { x: 50, y: 86 },
        eyeLeftPivot: { x: 36, y: 48 },
        eyeRightPivot: { x: 64, y: 48 },
        mouthPivot: { x: 50, y: 65 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 88 },
        eyeLeftPivot: { x: 36, y: 50 },
        eyeRightPivot: { x: 64, y: 50 },
        mouthPivot: { x: 50, y: 74 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.16, translateMaxPx: 0 },
    },
    Render: Cat,
    RenderCall: CatCall,
  },
  bat: {
    meta: {
      id: 'bat',
      name: 'Bat',
      anchors: {
        breathePivot: { x: 50, y: 65 },
        eyeLeftPivot: { x: 44, y: 50 },
        eyeRightPivot: { x: 56, y: 50 },
        mouthPivot: { x: 50, y: 60 },
        mouthAxis: 'y',
      },
      callAnchors: {
        breathePivot: { x: 50, y: 70 },
        eyeLeftPivot: { x: 43, y: 50 },
        eyeRightPivot: { x: 57, y: 50 },
        mouthPivot: { x: 50, y: 62 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.22, translateMaxPx: 0 },
    },
    Render: Bat,
    RenderCall: BatCall,
  },

  // ── Paid (rare + legendary) ─────────────────────────────────
  // The paid catalog lives in `./catalog.ts`. Each id is registered
  // here so AvatarRenderer can dispatch on it; ownership is gated
  // separately at the picker level. Renders not yet illustrated
  // use a brass-square placeholder.

  lynx: {
    meta: {
      id: 'lynx' as never,
      name: 'Lynx',
      anchors: {
        breathePivot: { x: 50, y: 76 },
        eyeLeftPivot: { x: 42, y: 50 },
        eyeRightPivot: { x: 58, y: 50 },
        mouthPivot: { x: 50, y: 68 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.16, translateMaxPx: 0 },
    },
    Render: Lynx,
  },
  // Phase B rares — fully illustrated. Anchor metadata comes from
  // each per-rare SVG's eye/mouth pivot points (see speakeasy-rares.html).
  koi: paidDef('Koi', { breathe: { x: 50, y: 60 }, eyeL: { x: 20, y: 51 }, eyeR: { x: 20, y: 51 }, mouth: { x: 12.5, y: 53.9 }, mouthAxis: 'x', scaleMax: 1.06 }, Koi),
  raven: paidDef('Raven', { breathe: { x: 50, y: 90 }, eyeL: { x: 56, y: 36 }, eyeR: { x: 56, y: 36 }, mouth: { x: 79, y: 43 }, mouthAxis: 'x', scaleMax: 1.18 }, Raven),
  frog: paidDef('Frog', { breathe: { x: 50, y: 72 }, eyeL: { x: 38, y: 32 }, eyeR: { x: 62, y: 32 }, mouth: { x: 50, y: 60 }, mouthAxis: 'y', scaleMax: 1.14 }, Frog),
  snake: paidDef('Snake', { breathe: { x: 50, y: 90 }, eyeL: { x: 43, y: 38 }, eyeR: { x: 57, y: 38 }, mouth: { x: 50, y: 44.5 }, mouthAxis: 'x', scaleMax: 1.08 }, Snake),
  peacock: paidDef('Peacock', { breathe: { x: 50, y: 86 }, eyeL: { x: 46, y: 48 }, eyeR: { x: 54, y: 48 }, mouth: { x: 51, y: 55 }, mouthAxis: 'y', scaleMax: 1.14 }, Peacock),
  hawk: paidDef('Hawk', { breathe: { x: 50, y: 92 }, eyeL: { x: 50, y: 36 }, eyeR: { x: 50, y: 36 }, mouth: { x: 75, y: 43 }, mouthAxis: 'x', scaleMax: 1.18 }, Hawk),
  squirrel: paidDef('Squirrel', { breathe: { x: 44, y: 86 }, eyeL: { x: 34, y: 42 }, eyeR: { x: 42, y: 42 }, mouth: { x: 38, y: 54 }, mouthAxis: 'y', scaleMax: 1.16 }, Squirrel),
  crab: paidDef('Crab', { breathe: { x: 50, y: 74 }, eyeL: { x: 43.7, y: 42 }, eyeR: { x: 56.3, y: 42 }, mouth: { x: 50, y: 58.7 }, mouthAxis: 'x', scaleMax: 1.08 }, Crab),
  beetle: paidDef('Beetle', { breathe: { x: 50, y: 80 }, eyeL: { x: 46, y: 33 }, eyeR: { x: 54, y: 33 }, mouth: { x: 50, y: 38.5 }, mouthAxis: 'x', scaleMax: 1.06 }, Beetle),
  anglerfish: paidDef('Anglerfish', { breathe: { x: 52, y: 80 }, eyeL: { x: 44, y: 42 }, eyeR: { x: 56, y: 42 }, mouth: { x: 46, y: 62 }, mouthAxis: 'y', scaleMax: 1.22 }, Anglerfish),
  seahorse: paidDef('Seahorse', { breathe: { x: 44, y: 90 }, eyeL: { x: 44, y: 20 }, eyeR: { x: 44, y: 20 }, mouth: { x: 21.5, y: 20.5 }, mouthAxis: 'x', scaleMax: 1.06 }, Seahorse),

  // Legendaries — Phase B fully illustrated.
  dragon: paidDef('Dragon', { breathe: { x: 50, y: 99 }, eyeL: { x: 42, y: 28 }, eyeR: { x: 58, y: 28 }, mouth: { x: 50, y: 49 }, mouthAxis: 'y', scaleMax: 1.16 }, Dragon),
  phoenix: paidDef('Phoenix', { breathe: { x: 50, y: 98 }, eyeL: { x: 46, y: 36 }, eyeR: { x: 54, y: 36 }, mouth: { x: 50, y: 46 }, mouthAxis: 'y', scaleMax: 1.18 }, Phoenix),
  turtle: paidDef('Turtle', { breathe: { x: 50, y: 86 }, eyeL: { x: 11, y: 46 }, eyeR: { x: 11, y: 46 }, mouth: { x: 8, y: 50.5 }, mouthAxis: 'x', scaleMax: 1.06 }, Turtle),
  manticore: paidDef('Manticore', { breathe: { x: 50, y: 80 }, eyeL: { x: 44, y: 40 }, eyeR: { x: 56, y: 40 }, mouth: { x: 50, y: 54 }, mouthAxis: 'y', scaleMax: 1.18 }, Manticore),
};

interface PaidAnchors {
  breathe: { x: number; y: number };
  eyeL: { x: number; y: number };
  eyeR: { x: number; y: number };
  mouth: { x: number; y: number };
  mouthAxis: 'x' | 'y';
  scaleMax: number;
}

function paidDef(name: string, a: PaidAnchors, Render: AnimalRender): AnimalDef {
  return {
    meta: {
      id: name.toLowerCase() as never,
      name,
      anchors: {
        breathePivot: a.breathe,
        eyeLeftPivot: a.eyeL,
        eyeRightPivot: a.eyeR,
        mouthPivot: a.mouth,
        mouthAxis: a.mouthAxis,
      },
      audioResponse: { scaleMin: 1.0, scaleMax: a.scaleMax, translateMaxPx: 0 },
    },
    Render,
  };
}

function paidPlaceholder(name: string, letter: string): AnimalDef {
  return {
    meta: {
      id: name.toLowerCase() as never,
      name,
      anchors: {
        breathePivot: { x: 50, y: 80 },
        eyeLeftPivot: { x: 50, y: 50 },
        eyeRightPivot: { x: 50, y: 50 },
        mouthPivot: { x: 50, y: 70 },
        mouthAxis: 'y',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.0, translateMaxPx: 0 },
    },
    Render: makePlaceholder(letter),
  };
}

export const ANIMAL_IDS = Object.keys(ANIMALS) as Array<keyof typeof ANIMALS>;

/**
 * Render a single animal at `100×100` viewBox. The caller wraps this
 * in an Animated.View for the breathing transform; this component
 * stays pure (props in, SVG out).
 */
/**
 * Renders a single animal's `def.Render(...)` output, isolated to its
 * own React fiber. Always mount via this component — never call
 * `ANIMALS[id].Render({...})` directly.
 *
 * **Why this exists** (rc.6 fox crash):
 * Per-animal Render functions can declare differing hook counts —
 * pre-rc.11 the discrete `useEmotionDrive` hook was called by Fox,
 * Hawk, and Raven, while free commons declared zero. Post-rc.11 the
 * continuous prosody system is centralized in `AvatarRenderer`, so
 * today only Raven calls a hook (`useHeadBob` — 3 hooks); the rest
 * are pure SVG. The invariant is still load-bearing: any future
 * per-animal Render that calls a hook would re-introduce the same
 * crash class. When an earlier version of the codebase inlined
 * `def.Render(...)` inside a long-lived parent (e.g. `AnimalSvg`,
 * `AvatarCacheWarmer`), per-animal hooks attributed to the
 * *parent's* fiber. Switching `animalId` on that parent meant the
 * fiber's hook-order check broke mid-render, and Hermes crashed the
 * release build with "Rendered more hooks than during the previous
 * render."
 *
 * `AnimalBody` is itself mounted with `key={animalId}` on its inner
 * `<RenderHost>`, so animal changes force a clean unmount + remount.
 * Consumers (`AnimalSvg`, `AvatarCacheWarmer`, any future site) just
 * use `<AnimalBody animalId={...} ... />` without having to remember
 * to pass a key — the invariant lives here.
 *
 * If you find yourself writing `def.Render(...)` somewhere new, stop
 * and use this component instead. The
 * `AvatarRenderer.regression.test.ts` invariant test exists to catch
 * that mistake at CI time.
 */
export function AnimalBody({
  animalId,
  eyeScale,
  mouthScale,
  amplitude,
  prosody,
  renderForCall,
  edgeColor,
  edgeTarget,
}: {
  animalId: string;
  eyeScale: AnimalRenderProps['eyeScale'];
  mouthScale: AnimalRenderProps['mouthScale'];
  amplitude: AnimalRenderProps['amplitude'];
  prosody?: AnimalRenderProps['prosody'];
  /**
   * rc.12 — when true AND the animal has a `RenderCall` variant,
   * the call-mask is mounted instead of the default `Render`.
   * Callers derive this from `prosody !== undefined`, so the call
   * surfaces (CallScreen, IncomingCallScreen) get it for free and
   * static surfaces (chat row, picker) never set it.
   */
  renderForCall?: boolean;
  /** #12 contrast outline color, or undefined to skip the edge layer. */
  edgeColor?: string;
  /**
   * #12 — the fill color that vanishes into the current background (BONE in
   * light mode, INK in dark). Only shapes painted this color get an edge;
   * brass + the already-contrasting color are left alone. Required whenever
   * `edgeColor` is set.
   */
  edgeTarget?: string;
}): React.ReactElement | null {
  const def = ANIMALS[animalId];
  if (!def) return null;
  // Variant selection. Falls back to the default Render when the
  // animal hasn't defined a call mask (rare + legendary tiers, or
  // when the caller isn't in a call context). Use `=== true` so
  // `useCallMask` is strictly boolean — the key suffix is then
  // unambiguous and a future `if (useCallMask === false)` reader
  // can't miss the undefined branch.
  const renderCall = def.RenderCall;
  const useCallMask = renderForCall === true && renderCall !== undefined;
  const render = useCallMask ? renderCall : def.Render;
  // Inner component on `key={animalId}-${variant}` is the load-bearing
  // piece — hooks called inside `def.Render(...)` attribute to
  // RenderHost's fiber, and a key change forces React to drop that
  // fiber and create a fresh one. Including the variant in the key
  // means swapping in/out of a call (default ↔ call-mask) also
  // resets hook order, so any future per-animal Render that adds
  // hooks doesn't trip the rc.6 "Rendered more hooks" class of crash.
  const variant = useCallMask ? 'call' : 'default';
  return (
    <>
      {edgeColor && edgeTarget ? (
        <EdgeHost
          key={`${animalId}-${variant}-edge`}
          render={render}
          eyeScale={eyeScale}
          mouthScale={mouthScale}
          amplitude={amplitude}
          prosody={prosody}
          color={edgeColor}
          target={edgeTarget}
        />
      ) : null}
      <RenderHost
        key={`${animalId}-${variant}`}
        render={render}
        eyeScale={eyeScale}
        mouthScale={mouthScale}
        amplitude={amplitude}
        prosody={prosody}
      />
    </>
  );
}

/**
 * Renders the mark recolored to the contrast `color` (the #12 outline
 * layer), drawn behind the real `RenderHost`. Hooks inside `render(...)`
 * attribute to THIS component's fiber (same contract as RenderHost), so
 * its own `key` keeps it isolated.
 */
function EdgeHost({
  render,
  color,
  target,
  eyeScale,
  mouthScale,
  amplitude,
  prosody,
}: {
  render: AnimalRender;
  color: string;
  target: string;
} & Omit<AnimalRenderProps, 'amplitude'> & {
    amplitude: AnimalRenderProps['amplitude'];
  }): React.ReactElement {
  return <>{recolorEdge(render({ eyeScale, mouthScale, amplitude, prosody }), color, target)}</>;
}

function RenderHost({
  render,
  eyeScale,
  mouthScale,
  amplitude,
  prosody,
}: {
  render: AnimalRender;
} & Omit<AnimalRenderProps, 'amplitude'> & { amplitude: AnimalRenderProps['amplitude'] }): React.ReactElement {
  return <>{render({ eyeScale, mouthScale, amplitude, prosody })}</>;
}

export function AnimalSvg({
  animalId,
  size,
  eyeScale,
  mouthScale,
  amplitude,
  prosody,
  renderForCall,
}: {
  animalId: string;
  size: number;
  eyeScale: AnimalRenderProps['eyeScale'];
  mouthScale: AnimalRenderProps['mouthScale'];
  /**
   * Optional. The renderer always passes a real Animated.Value;
   * static call sites (e.g. PortraitTile previews that ship a static
   * pose) can omit, in which case a no-op zero-value backs the prop.
   */
  amplitude?: AnimalRenderProps['amplitude'];
  prosody?: AnimalRenderProps['prosody'];
  /** rc.12 — see `AnimalBody`. Pass-through. */
  renderForCall?: boolean;
}): React.ReactElement | null {
  // Stable zero-amplitude backing Animated.Value — reused across
  // PortraitTile renders so static previews don't allocate a fresh
  // value every paint.
  const zeroAmpRef = React.useRef<Animated.Value | null>(null);
  if (zeroAmpRef.current === null) zeroAmpRef.current = new Animated.Value(0);
  // Per-theme contrast outline (#12) — AnimalBody draws the recolored edge
  // layer behind the real mark. Only the shapes whose fill is the vanishing
  // color (`edgeTarget`) get the `edgeColor` hairline; brass is left alone.
  // Light: BONE shapes vanish on cream → INK edge. Dark: INK shapes vanish
  // on aubergine → BONE edge. See `recolorEdge`.
  const { mode } = useTheme();
  const isDark = mode === 'dark';
  const edgeColor = isDark ? BONE : INK;
  const edgeTarget = isDark ? INK : BONE;
  if (!ANIMALS[animalId]) return null;
  const amp = amplitude ?? zeroAmpRef.current;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <AnimalBody
        animalId={animalId}
        eyeScale={eyeScale}
        mouthScale={mouthScale}
        amplitude={amp}
        prosody={prosody}
        renderForCall={renderForCall}
        edgeColor={edgeColor}
        edgeTarget={edgeTarget}
      />
    </Svg>
  );
}
