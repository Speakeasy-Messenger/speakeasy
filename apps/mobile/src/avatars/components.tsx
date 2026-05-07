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
import type { AnimalDef, AnimalRender, AnimalRenderProps } from './types.js';

// react-native-svg's animated wrappers. Passed Animated.Values via the
// `scaleY` prop; native driver isn't supported on SVG transforms but the
// JS-driver overhead at our update rates (60Hz idle, 30Hz audio) is in
// the noise on a release build.
const AnimatedG = Animated.createAnimatedComponent(G);

// Brand-locked colors — duplicated here from `theme/tokens.ts` so the
// SVG markup is fully self-contained (animal SVGs are intended to be
// art assets, not theme-aware components).
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

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

// ─────────────────────────────────────────────────────────────────────

const Fox: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* ear silhouettes */}
    <Polygon points="18,12 38,12 28,32" fill={BRASS} />
    <Polygon points="62,12 82,12 72,32" fill={BRASS} />
    {/* ear inner */}
    <Polygon points="24,18 32,18 28,28" fill={INK} />
    <Polygon points="68,18 76,18 72,28" fill={INK} />
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
    <Mouth pivot={{ x: 50, y: 60 }} scale={mouthScale} axis="y">
      <Polygon points="46,60 54,60 50,66" fill={INK} />
    </Mouth>
  </>
);

const Owl: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
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
  </>
);

const Raven: AnimalRender = ({ eyeScale, mouthScale }) => (
  // Profile silhouette — single eye, beak as the mouth element. The
  // beak axis is X (horizontal "click") rather than Y, since the bird
  // is in profile and a vertical scale would distort the silhouette.
  <>
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
  </>
);

const Hare: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* outer ears (bone) */}
    <Rect x={33} y={6} width={11} height={38} rx={5} fill={BONE} />
    <Rect x={56} y={6} width={11} height={38} rx={5} fill={BONE} />
    {/* inner ears (brass) */}
    <Rect x={36} y={12} width={5} height={26} rx={2} fill={BRASS} />
    <Rect x={59} y={12} width={5} height={26} rx={2} fill={BRASS} />
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

const Stag: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
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
  </>
);

const Whale: AnimalRender = ({ eyeScale, mouthScale }) => (
  // Profile pose; "mouth" is the entire smile-line implied by the body
  // silhouette — animation here is subtle. We scale the eye normally
  // but leave the mouth axis on `'x'` and ride the audio amplitude
  // gently against the body's belly path.
  <>
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
  </>
);

const Moth: AnimalRender = ({ eyeScale, mouthScale }) => (
  // Moths don't have visible eyes-as-eyes — the wing dots stand in. We
  // wire `eyeScale` to the wing dots so they still "blink" on the same
  // cadence; reads as a wing flutter. Mouth has no visible analog —
  // accept the amplitude signal and drive the body ellipse subtly.
  <>
    <Path d="M46,18 Q40,8 32,6" stroke={INK} strokeWidth={1.5} fill="none" />
    <Path d="M54,18 Q60,8 68,6" stroke={INK} strokeWidth={1.5} fill="none" />
    <Path d="M50,28 L18,22 L10,42 L50,52 Z" fill={BRASS} />
    <Path d="M50,28 L82,22 L90,42 L50,52 Z" fill={BRASS} />
    <Path d="M50,52 L20,52 L28,76 L50,68 Z" fill={BONE} />
    <Path d="M50,52 L80,52 L72,76 L50,68 Z" fill={BONE} />
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

const Octopus: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* mantle */}
    <Path
      d="M22,42 Q22,18 50,18 Q78,18 78,42 L78,58 Q78,62 74,62 L26,62 Q22,62 22,58 Z"
      fill={BRASS}
    />
    {/* tentacles */}
    <Path d="M26,62 Q20,75 28,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
    <Path d="M36,62 Q32,80 42,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
    <Path d="M46,62 L44,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
    <Path d="M54,62 L56,90" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
    <Path d="M64,62 Q68,80 58,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
    <Path d="M74,62 Q80,75 72,88" stroke={BRASS} strokeWidth={5} fill="none" strokeLinecap="round" />
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

const Heron: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* body */}
    <Ellipse cx={60} cy={72} rx={22} ry={14} fill={BONE} />
    {/* neck S-curve */}
    <Path d="M58,62 Q40,52 44,32 Q48,18 60,16" stroke={BONE} strokeWidth={8} fill="none" strokeLinecap="round" />
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
    <Mouth pivot={{ x: 80, y: 16 }} scale={mouthScale} axis="x">
      <Polygon points="68,14 92,18 68,20" fill={BRASS} />
    </Mouth>
    {/* legs */}
    <Line x1={54} y1={84} x2={50} y2={96} stroke={BRASS} strokeWidth={2} />
    <Line x1={66} y1={84} x2={70} y2={96} stroke={BRASS} strokeWidth={2} />
  </>
);

const Bear: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
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
  </>
);

const Cat: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* outer ear triangles */}
    <Polygon points="14,32 30,8 36,32" fill={INK} />
    <Polygon points="64,32 70,8 86,32" fill={INK} />
    {/* inner ear triangles */}
    <Polygon points="22,28 30,15 32,28" fill={BRASS} />
    <Polygon points="68,28 70,15 78,28" fill={BRASS} />
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

const Bat: AnimalRender = ({ eyeScale, mouthScale }) => (
  <>
    {/* wings — angular zigzag */}
    <Path d="M50,46 L20,30 L8,42 L18,46 L8,54 L24,58 L50,52 Z" fill={INK} />
    <Path d="M50,46 L80,30 L92,42 L82,46 L92,54 L76,58 L50,52 Z" fill={INK} />
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 2 },
    },
    Render: Fox,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.14, translateMaxPx: 0 },
    },
    Render: Owl,
  },
  raven: {
    meta: {
      id: 'raven',
      name: 'Raven',
      anchors: {
        breathePivot: { x: 50, y: 76 },
        eyeLeftPivot: { x: 38, y: 44 },
        eyeRightPivot: { x: 38, y: 44 },
        mouthPivot: { x: 70, y: 52 },
        mouthAxis: 'x',
      },
      audioResponse: { scaleMin: 1.0, scaleMax: 1.22, translateMaxPx: 0 },
    },
    Render: Raven,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 0 },
    },
    Render: Hare,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.16, translateMaxPx: 0 },
    },
    Render: Stag,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.06, translateMaxPx: 0 },
    },
    Render: Whale,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.06, translateMaxPx: 0 },
    },
    Render: Moth,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.0, translateMaxPx: 0 },
    },
    Render: Octopus,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.2, translateMaxPx: 0 },
    },
    Render: Heron,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.18, translateMaxPx: 3 },
    },
    Render: Bear,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.16, translateMaxPx: 0 },
    },
    Render: Cat,
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
      audioResponse: { scaleMin: 1.0, scaleMax: 1.22, translateMaxPx: 0 },
    },
    Render: Bat,
  },
};

export const ANIMAL_IDS = Object.keys(ANIMALS) as Array<keyof typeof ANIMALS>;

/**
 * Render a single animal at `100×100` viewBox. The caller wraps this
 * in an Animated.View for the breathing transform; this component
 * stays pure (props in, SVG out).
 */
export function AnimalSvg({
  animalId,
  size,
  eyeScale,
  mouthScale,
}: {
  animalId: string;
  size: number;
  eyeScale: AnimalRenderProps['eyeScale'];
  mouthScale: AnimalRenderProps['mouthScale'];
}): React.ReactElement | null {
  const def = ANIMALS[animalId];
  if (!def) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {def.Render({ eyeScale, mouthScale })}
    </Svg>
  );
}
