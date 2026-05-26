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
import type { AcousticEvent } from '../calls/audio-feature-extractor.js';

/**
 * Phase 5j Private Call — the continuous prosody channels (plus the
 * one-shot acoustic event) the peer's audio pipeline produces, as
 * the receiver sees them. The avatar Render maps these onto its
 * own animation vocabulary — mouth shape, head tilt, fidget rate,
 * gesture amplitude, signature pose.
 *
 * Numeric values, NOT Animated.Values — the AvatarRenderer drives
 * its internal Animated.Values from these on prop change. Numeric
 * values let the prosody flow through the React tree as a normal
 * prop (zustand-driven re-renders at 30 Hz) without each consumer
 * having to wire its own Animated.Value handles.
 *
 * `amplitude` is duplicated here from the AvatarRenderer's existing
 * `amplitude` prop. Call sites for the *peer* avatar set prosody;
 * call sites for the *local self* avatar set `amplitude` only
 * (everything else stays at neutral defaults).
 *
 * `eventAt` is the receiver's local clock at the moment the event
 * arrived — used to tick the one-shot pose overlay's ~1.5 s
 * lifetime against the receiver's clock so sender/receiver clock
 * drift doesn't shorten or extend it.
 */
export interface ProsodyState {
  amplitude: number;
  pitchNorm: number;
  zcrNorm: number;
  mouthShape: number;
  pitchTrend: number;
  expressiveness: number;
  activity: number;
  event: AcousticEvent;
  eventAt: number;
}

/** Neutral prosody — every channel at rest, no event. Use as a
 *  static fallback at mount sites that don't have a peer feed
 *  (picker tiles, chat list rows, etc.). */
export const NEUTRAL_PROSODY: ProsodyState = {
  amplitude: 0,
  pitchNorm: 0,
  zcrNorm: 0,
  mouthShape: 0,
  pitchTrend: 0,
  expressiveness: 0,
  activity: 0,
  event: 'none',
  eventAt: 0,
};

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

export interface AnimalAnchors {
  breathePivot: Pivot;
  eyeLeftPivot: Pivot;
  eyeRightPivot: Pivot;
  mouthPivot: Pivot;
  /** `'y'` for most animals (mouth opens). `'x'` for animals where
   * the visible motion is a beak click rather than a jaw drop. */
  mouthAxis: 'x' | 'y';
}

export interface AnimalMeta {
  id: AnimalId;
  name: string;
  /** AVATAR-SYSTEM.md §2.3 — origin for each transform. Eyes blink in
   * place; the mouth scales (and optionally translates) from this
   * point; the breathe pivot anchors the whole-figure scale to the
   * bottom of the silhouette so it reads as inhalation, not float. */
  anchors: AnimalAnchors;
  /**
   * rc.12 — call-mask anchors. Set on animals whose `RenderCall`
   * variant moved the eye / mouth / breathe pivots (most re-posed
   * call masks). Animals whose call mask keeps the default pivots
   * (or that don't have a `RenderCall`) leave this undefined and
   * the renderer falls back to `anchors`. Currently consumed only
   * by code paths that *read* anchors for layout (none in v1 — the
   * Render fn pins its own pivots inline); reserved here so the
   * future renderer-level mouth-amplitude pipeline doesn't have to
   * rummage in the Render function to find them.
   */
  callAnchors?: AnimalAnchors;
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
  /**
   * Phase 5j Private Call (rc.11 prosody rewrite) — the receiver's
   * latest snapshot of the peer's continuous prosody channels +
   * any active one-shot acoustic event. Per-animal Renders pick
   * the channels they care about (fox ears watch pitchTrend, hawk
   * head watches expressiveness, raven feathers watch activity,
   * etc.) and ignore the rest.
   *
   * Driven by Animated.Values inside `AvatarRenderer` — see
   * `useProsodyAnimatedValues` — so per-animal Renders get
   * AnimatedInterpolation<number> handles instead of raw numbers.
   * This lets each animal compose prosody channels with its own
   * Animated values (e.g., blink × emotion-eye-scale) without
   * forcing a re-render per frame.
   *
   * Optional + defaults to a neutral set so non-private call sites
   * (chat row avatars, picker tiles) render the rest pose.
   */
  prosody?: AnimatedProsody;
};

/**
 * Animated counterpart to `ProsodyState` that per-animal Renders
 * consume. `event` + `eventAt` are *not* animated — they're
 * one-shot triggers; the overlay system reads them as plain values
 * via `useProsodyEvent`.
 */
export interface AnimatedProsody {
  amplitude: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  pitchNorm: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  zcrNorm: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  mouthShape: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  pitchTrend: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  expressiveness: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  activity: RNAnimated.Value | RNAnimated.AnimatedInterpolation<number>;
  event: AcousticEvent;
  eventAt: number;
}

export type AnimalRender = (props: AnimalRenderProps) => React.ReactElement;

export interface AnimalDef {
  meta: AnimalMeta;
  Render: AnimalRender;
  /**
   * rc.12 — optional call-mask Render variant. Used in *call*
   * contexts only (anywhere the avatar receives a non-undefined
   * `prosody` prop — CallScreen, IncomingCallScreen during the
   * connected stage). Re-posed and feature-amplified vs the default
   * `Render`, which stays in use for chat rows / picker grids /
   * AppBar / IdReveal previews / push-notification thumbnails.
   *
   * Optional: animals without a `RenderCall` fall through to
   * `Render` in every context. Free-common tier has the full set;
   * rare + legendary tiers can opt in over time.
   */
  RenderCall?: AnimalRender;
}
