/**
 * Animal avatar types — see AVATAR-SYSTEM.md §2.
 *
 * Each launch animal ships as a `react-native-svg` render function that
 * accepts animation drivers for the eye + mouth elements. The renderer
 * wraps the result in an Animated.View for breathing, so the rest of
 * the app composes via the `<AvatarRenderer />` primitive and never
 * touches per-animal markup directly.
 *
 * The 12 launch animals are placeholder art lifted from
 * `speakeasy-animals.html`. Spec §1 calls them "not shippable" but the
 * user has explicitly opted in to ship them as MVP — replace post-
 * illustrator without changing the contract here.
 */

import type React from 'react';
// react-native's Animated namespace. Imported as a type for the value
// handles passed to the per-animal render functions.
import type { Animated as RNAnimated } from 'react-native';

/** Stable identifier persisted in the user's profile + sent on
 *  conversation handshake to peers. Don't rename without a migration.
 *
 *  Note: this union covers the 12 free animals — the source-of-truth
 *  for what's renderable. Paid avatars (rare + legendary) are
 *  registered into the same `ANIMALS: Record<string, AnimalDef>` map
 *  but live outside this union; consumers that select arbitrary
 *  animals (the picker, the renderer dispatch) take `string` and
 *  fall back gracefully when the id is unknown. */
export type AnimalId =
  | 'fox'
  | 'owl'
  | 'pigeon'
  | 'hare'
  | 'stag'
  | 'whale'
  | 'moth'
  | 'octopus'
  | 'heron'
  | 'bear'
  | 'cat'
  | 'bat';

export interface Pivot {
  x: number;
  y: number;
}

export interface AudioResponse {
  /** Scale at silence. Always 1.0 — the mouth at rest is whatever shape
   * the artist drew. */
  scaleMin: number;
  /** Scale at full amplitude (a normal speaking voice ≈ 0.6 RMS, peak
   * ≈ 1.0). 1.18 means the mouth grows 18% taller during loud speech.
   * Tuneable per-animal because a fox's small triangle nose moves more
   * visibly per amplitude unit than a beak does. */
  scaleMax: number;
  /** Vertical pixel translation at full amplitude. Used for animals
   * where the jaw visibly drops (bear). 0 for everyone else. */
  translateMaxPx: number;
}

export interface AnimalMeta {
  id: AnimalId;
  name: string;
  /** AVATAR-SYSTEM.md §2.3 — origin for each transform. Eyes blink in
   * place; the mouth scales (and optionally translates) from this
   * point; the breathe pivot anchors the whole-figure scale to the
   * bottom of the silhouette so it reads as inhalation, not float. */
  anchors: {
    breathePivot: Pivot;
    eyeLeftPivot: Pivot;
    eyeRightPivot: Pivot;
    mouthPivot: Pivot;
    /** `'y'` for most animals (mouth opens). `'x'` for animals where
     * the visible motion is a beak click rather than a jaw drop. */
    mouthAxis: 'x' | 'y';
  };
  audioResponse: AudioResponse;
}

/**
 * Per-animal Render function signature. The `<AvatarRenderer />`
 * passes Animated.Value handles in for eye + mouth scale; the animal
 * wires those into the relevant SVG groups. Breathing is applied
 * outside the animal (around the whole figure), so the render fn
 * sees a 100×100 viewBox and the renderer wraps it in Animated.View
 * with the breathing transform.
 */
export type AnimalRenderProps = {
  eyeScale: RNAnimated.AnimatedInterpolation<number>;
  mouthScale: RNAnimated.AnimatedInterpolation<number>;
  /**
   * Raw amplitude in [0, 1] — same source the renderer derives
   * `mouthScale` from, but exposed here so paid-tier animals can
   * drive their per-animal signature effect (lynx tuft twitch,
   * raven head tilt, etc.) off the live mic level.
   *
   * Free animals ignore this prop. The renderer always provides an
   * Animated.Value (zero when no audio source is wired).
   */
  amplitude: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
};

export type AnimalRender = (props: AnimalRenderProps) => React.ReactElement;

export interface AnimalDef {
  meta: AnimalMeta;
  Render: AnimalRender;
}
