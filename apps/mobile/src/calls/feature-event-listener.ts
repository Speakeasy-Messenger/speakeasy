/**
 * Phase 5j Private Call — bridge between the native voice-filter
 * module's per-window feature event and the orchestrator's
 * animation data channel.
 *
 * Listening side (this file):
 *   - Subscribes to the `SpeakeasyVoiceFilterFeatures` event the
 *     native module emits at ~30 Hz (every FEATURE_WINDOW_MS) when
 *     a Private Call is active.
 *   - Runs each raw feature triple through `AudioFeatureExtractor.
 *     pushRawFeatures` so the same calibration + follower-smoothing
 *     applies that the JS-only `push(Float32Array)` path uses.
 *   - Runs the smoothed features through `EmotionStateMachine.push`
 *     to derive the discrete `baseline | excited | calm` state.
 *   - Packs `{ amplitude, emotionState, pitchNorm, zcrNorm }` into
 *     an `AnimationFrame` and hands it to
 *     `orchestrator.sendAnimationFrame`, which encodes 6 bytes onto
 *     the unreliable+unordered WebRTC data channel for the peer
 *     to drive its avatar.
 *
 * Why not in App.tsx directly: keeps the orchestrator + native
 * subscription wiring in one tested file and avoids growing
 * App.tsx's already-busy bootstrap with another callback ladder.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from './orchestrator.js';
import {
  AudioFeatureExtractor,
  type RawFeatures,
} from './audio-feature-extractor.js';
import { EmotionStateMachine } from './emotion-state-machine.js';

/**
 * Event name emitted by `SpeakeasyVoiceFilter` (both platforms) when
 * the voice filter has a fresh feature window. Payload shape is
 * `RawFeatures` (loudness, pitchHz, zcr) plus a `sampleRate` so the
 * JS side can validate without hard-coding 48000.
 */
const EVENT_NAME = 'SpeakeasyVoiceFilterFeatures';

interface NativeFeatureEvent extends RawFeatures {
  /** Sample rate the native side used; informational + sanity. */
  sampleRate: number;
}

/**
 * Attach the listener. Returns an unsubscribe — call it when the
 * orchestrator deps tear down (e.g., on logout). The subscription
 * itself is cheap and lives for the app's lifetime; the feature
 * events only fire while a Private Call is active (the native
 * module is responsible for that gating).
 */
export function attachFeatureEventListener(
  orchestrator: CallOrchestrator,
): () => void {
  const nativeModule = NativeModules.SpeakeasyVoiceFilter as
    | { isAvailable?: boolean }
    | undefined;
  if (!nativeModule) {
    // Test environment or platform without the native module.
    // Returning a no-op unsubscribe keeps caller code uniform.
    diag('call', 'feature-event listener: native module absent — no-op');
    return () => {};
  }
  const emitter = new NativeEventEmitter(
    NativeModules.SpeakeasyVoiceFilter as never,
  );

  // Per-call state: when the orchestrator's `active` flips away
  // from kind:'private', the extractor + state machine reset so a
  // future Private Call starts with a fresh ZCR baseline and
  // baseline emotion. We rebuild them lazily on the first event
  // after `attachOnActiveChange` sees a new private call.
  let extractor = new AudioFeatureExtractor();
  let stateMachine = new EmotionStateMachine();
  let lastCallId: string | undefined;

  const sub = emitter.addListener(EVENT_NAME, (raw: NativeFeatureEvent) => {
    const active = (orchestrator as any).active as
      | { callId: string; kind: 'audio' | 'video' | 'private' }
      | undefined;
    if (!active || active.kind !== 'private') {
      // Stray event from a torn-down filter; drop silently.
      return;
    }
    if (active.callId !== lastCallId) {
      // New private call — fresh extractor / state machine state.
      extractor = new AudioFeatureExtractor({ sampleRate: raw.sampleRate });
      stateMachine = new EmotionStateMachine();
      lastCallId = active.callId;
    }
    // Smooth + normalize the native-supplied raw features through
    // the existing follower + calibration; the EmotionStateMachine
    // hysteresis then derives a stable discrete state.
    const features = extractor.pushRawFeatures({
      loudness: raw.loudness,
      pitchHz: raw.pitchHz,
      zcr: raw.zcr,
    });
    const emotionState = stateMachine.push(features);
    // Hand off to the orchestrator — sendAnimationFrame encodes the
    // 6-byte payload + ships over the data channel. The receiver
    // decodes via `decodeAnimationFrame` (from animation-channel.ts)
    // and pushes into `usePeerAnimation`, which CallScreen reads
    // to drive the peer's avatar emotionState + mouth.
    orchestrator.sendAnimationFrame({
      amplitude: features.loudness,
      emotionState,
      pitchNorm: features.pitchNorm,
      zcrNorm: features.zcrNorm,
    });
  });

  return () => sub.remove();
}
