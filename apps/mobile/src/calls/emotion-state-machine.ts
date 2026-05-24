import type { NormalizedFeatures } from './audio-feature-extractor.js';

/**
 * Phase 5j Private Call — discrete emotion classification on top of
 * the audio feature extractor. Three states drive avatar Render
 * parameter overrides (eyeScale, blink interval, per-animal
 * amplitude boost / posture); the state machine is intentionally
 * deterministic + hysteretic per /plan-design-review D8 — continuous
 * interpolation was rejected for v1 (over-engineering; the testable
 * state contract is easier to QA visually and to ship behind a kill
 * switch if a state turns out wrong).
 *
 * The state values plus their parameter overrides are the locked
 * `Avatar emotion tracking` section of the CEO/eng plan; the
 * thresholds + hysteresis are locked in the design review.
 *
 * Hysteresis prevents the avatar's face from flickering between
 * states when signals straddle the threshold mid-sentence. Without
 * it: 'excited' fires the first time loudness×pitch crosses 0.6,
 * leaves the first time either dips below 0.6 — easy to get 3–5
 * flickers per sentence as natural prosody scoops in and out. With
 * it: enter at >0.6, leave at <0.5 (or for calm: enter at <0.3 +
 * <0.4, leave at >0.4 + >0.5). Gives a ~0.1 dead-band that
 * eliminates the predictable flicker mode at near-zero cost.
 */

export type EmotionState = 'baseline' | 'excited' | 'calm';

const EXCITED_ENTER_LOUDNESS = 0.6;
const EXCITED_ENTER_PITCH = 0.6;
const EXCITED_LEAVE_LOUDNESS = 0.5;
const EXCITED_LEAVE_PITCH = 0.5;

const CALM_ENTER_LOUDNESS = 0.3;
const CALM_ENTER_PITCH = 0.4;
const CALM_LEAVE_LOUDNESS = 0.4;
const CALM_LEAVE_PITCH = 0.5;

export class EmotionStateMachine {
  private state: EmotionState = 'baseline';

  /** Push one frame of smoothed normalized features; return the
   *  resulting (possibly transitioned) state. Call at the same 30 Hz
   *  cadence as `AudioFeatureExtractor.push`. */
  push(features: NormalizedFeatures): EmotionState {
    const { loudness, pitchNorm } = features;
    switch (this.state) {
      case 'baseline':
        if (
          loudness > EXCITED_ENTER_LOUDNESS &&
          pitchNorm > EXCITED_ENTER_PITCH
        ) {
          this.state = 'excited';
        } else if (
          loudness < CALM_ENTER_LOUDNESS &&
          pitchNorm < CALM_ENTER_PITCH
        ) {
          this.state = 'calm';
        }
        break;
      case 'excited':
        // Leave when EITHER signal drops below the leave threshold
        // (OR rather than AND so a single soft moment lets the face
        // relax; the enter condition uses AND to prevent accidental
        // 'excited' on a single loud syllable in an otherwise calm
        // turn). Asymmetric on purpose.
        if (
          loudness < EXCITED_LEAVE_LOUDNESS ||
          pitchNorm < EXCITED_LEAVE_PITCH
        ) {
          this.state = 'baseline';
        }
        break;
      case 'calm':
        // Mirror logic: leave calm when EITHER signal pops above the
        // leave threshold.
        if (
          loudness > CALM_LEAVE_LOUDNESS ||
          pitchNorm > CALM_LEAVE_PITCH
        ) {
          this.state = 'baseline';
        }
        break;
    }
    return this.state;
  }

  get current(): EmotionState {
    return this.state;
  }
}

/**
 * Avatar Render parameter overrides for each emotion state. The
 * locked values from the plan's "Avatar emotion tracking" section.
 * `eyeScale` is multiplicative on the animal's baseline eye size;
 * `blinkIntervalSec` is the seconds between blinks; `amplitudeBoost`
 * scales the per-animal mouth-amplitude response. `baseline` returns
 * neutral (1.0 / 5 / 1.0) so unwiring is a no-op.
 */
export interface EmotionRenderParams {
  eyeScale: number;
  blinkIntervalSec: number;
  amplitudeBoost: number;
}

export function renderParamsFor(state: EmotionState): EmotionRenderParams {
  switch (state) {
    case 'excited':
      return { eyeScale: 1.15, blinkIntervalSec: 3, amplitudeBoost: 1.2 };
    case 'calm':
      return { eyeScale: 1.0, blinkIntervalSec: 8, amplitudeBoost: 0.85 };
    case 'baseline':
    default:
      return { eyeScale: 1.0, blinkIntervalSec: 5, amplitudeBoost: 1.0 };
  }
}
