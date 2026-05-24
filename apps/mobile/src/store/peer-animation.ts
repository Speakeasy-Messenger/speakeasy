import { create } from 'zustand';
import type { EmotionState } from '../calls/emotion-state-machine.js';

/**
 * Phase 5j Private Call — receiver-side store of the peer's live
 * animation state, updated 30× per second from the WebRTC data
 * channel. The avatar Render subscribes to this and applies the
 * values to the peer's animated SVG (mouth amplitude, eye scale via
 * `renderParamsFor`, per-animal posture cues).
 *
 * Why a store and not a plain ref? The animal Render is a React
 * subtree (per-call), and we want zustand's selector-based
 * subscription so a render only re-runs when its own peer's values
 * change (multi-call ringing doesn't ever happen for Speakeasy, but
 * the per-peer indirection keeps the API clean even at one peer).
 *
 * Not persisted — these are call-lifetime values. `clear()` wipes
 * everything when the call ends.
 */

export interface PeerAnimationState {
  /** 0..1 — drives mouth scale on the peer's avatar Render. */
  amplitude: number;
  /** Categorical emotion (baseline/excited/calm). */
  emotionState: EmotionState;
  /** 0..1 — raw pitch signal, exposed for per-animal posture cues. */
  pitchNorm: number;
  /** 0..1 — raw ZCR signal, same use. */
  zcrNorm: number;
}

interface PeerAnimationStore {
  byPeerId: Record<string, PeerAnimationState>;
  /** Push a fresh frame; the avatar Render subscribed to this peer
   *  re-renders on each push. Called by the orchestrator's data-
   *  channel message handler. */
  set: (peerId: string, state: PeerAnimationState) => void;
  /** Drop a single peer (called on call end). */
  clear: (peerId: string) => void;
  /** Drop everything (call cleanup / logout). */
  reset: () => void;
}

const NEUTRAL: PeerAnimationState = {
  amplitude: 0,
  emotionState: 'baseline',
  pitchNorm: 0,
  zcrNorm: 0,
};

export const usePeerAnimation = create<PeerAnimationStore>((set) => ({
  byPeerId: {},
  set: (peerId, state) =>
    set((s) => ({ byPeerId: { ...s.byPeerId, [peerId]: state } })),
  clear: (peerId) =>
    set((s) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [peerId]: _, ...rest } = s.byPeerId;
      return { byPeerId: rest };
    }),
  reset: () => set({ byPeerId: {} }),
}));

/** Convenience selector: returns the named peer's current animation
 *  state, or a neutral default when no data has arrived yet (channel
 *  still negotiating, or this isn't a Private Call). */
export function selectPeerAnimation(
  state: { byPeerId: Record<string, PeerAnimationState> },
  peerId: string,
): PeerAnimationState {
  return state.byPeerId[peerId] ?? NEUTRAL;
}
