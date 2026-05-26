import { create } from 'zustand';
import type { AcousticEvent } from '../calls/audio-feature-extractor.js';

/**
 * Phase 5j Private Call — receiver-side store of the peer's live
 * animation state, updated 30× per second from the WebRTC data
 * channel. The avatar Render subscribes to this and applies the
 * values to the peer's animated SVG.
 *
 * The state mirrors the wire-format AnimationFrame's continuous
 * channels (mouthShape / pitchTrend / expressiveness / activity) plus
 * the existing amplitude / pitchNorm / zcrNorm. The one-shot
 * acoustic `event` is also surfaced here, but in a "latest event +
 * timestamp" shape — the avatar treats receipt of an event as a
 * trigger to mount a ~1.5 s pose overlay and ignore subsequent
 * frames' `event` field until the overlay completes.
 *
 * Why a store and not a plain ref? The animal Render is a React
 * subtree (per-call), and we want zustand's selector-based
 * subscription so a render only re-runs when its own peer's values
 * change. Multi-call ringing doesn't happen for Speakeasy, but the
 * per-peer indirection keeps the API clean even at one peer.
 *
 * Not persisted — these are call-lifetime values. `clear()` wipes
 * everything when the call ends.
 */

export interface PeerAnimationState {
  /** 0..1 — drives mouth Y scale on the peer's avatar Render. */
  amplitude: number;
  /** 0..1 — raw normalized pitch. */
  pitchNorm: number;
  /** 0..1 — raw normalized ZCR. */
  zcrNorm: number;
  /** 0..1 — mouth-pose proxy (vowels open, fricatives don't). */
  mouthShape: number;
  /** -1..1 — pitch trend over ~200 ms. */
  pitchTrend: number;
  /** 0..1 — pitch CoV over ~1 s; gesture-amplitude multiplier. */
  expressiveness: number;
  /** 0..1 — voiced-transition rate; fidget driver. */
  activity: number;
  /** Most recently received acoustic event + when it arrived. The
   *  receiver mounts a one-shot pose overlay on event change and
   *  clears it ~1.5 s later. `'none'` means no overlay should
   *  render. `eventAt` is the local clock at receive time so the
   *  overlay's lifetime ticks against the receiver's clock (not
   *  the sender's, which would skew on clock drift). */
  event: AcousticEvent;
  eventAt: number;
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
  pitchNorm: 0,
  zcrNorm: 0,
  mouthShape: 0,
  pitchTrend: 0,
  expressiveness: 0,
  activity: 0,
  event: 'none',
  eventAt: 0,
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

/** Stable neutral state — exposed for components that want to
 *  reference the same object identity across renders (cheap
 *  shallow-compare wins for memoization). */
export const NEUTRAL_PEER_ANIMATION: PeerAnimationState = NEUTRAL;
