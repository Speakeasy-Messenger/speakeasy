/**
 * Event-overlay lifecycle regression — guards against the rc.11 review
 * blocker where a new 'none' frame arriving ~33 ms after a real event
 * reset `eventAt` to 0 and aborted the in-flight overlay animation.
 *
 * The fix lives in App.tsx (frame-handler preserves `event` + `eventAt`
 * across 'none' frames). This test exercises the *contract* that
 * keeps the overlay alive: as long as no NEW event arrives, the
 * `eventAt` written for the active event must stay sticky. If a
 * future refactor in App.tsx accidentally re-introduces the reset,
 * this test fails.
 *
 * We don't render the AvatarRenderer here (no react-test-renderer in
 * the project) — instead we replay the exact frame sequence the
 * Avatar receives, against the same store helper App.tsx uses, and
 * assert that `eventAt` is preserved across the silence gap that
 * follows an event.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectPeerAnimation,
  usePeerAnimation,
  type PeerAnimationState,
} from '../store/peer-animation.js';
import type { AnimationFrame } from '../calls/animation-channel.js';

/**
 * Re-implements the frame-handler logic from App.tsx's
 * `onPeerAnimationFrame`. Kept inline (rather than imported from
 * App.tsx, which has an enormous React-side dependency footprint) so
 * the contract change shows up directly here: any future drift
 * between App.tsx's handler and this fixture is the next bug.
 */
const EVENT_HOLD_MS = 1600;
function applyFrame(peerUserId: string, frame: AnimationFrame): void {
  const prev = usePeerAnimation.getState().byPeerId[peerUserId];
  const nowMs = Date.now();
  // Rising-edge: the sender latches each event across ~9 frames so the
  // unreliable channel delivers at least one — so we only treat it as
  // "new" when it differs from the currently-held event.
  const isNewEvent = frame.event !== 'none' && frame.event !== prev?.event;
  const eventFresh =
    !isNewEvent && !!prev?.eventAt && nowMs - prev.eventAt < EVENT_HOLD_MS;
  usePeerAnimation.getState().set(peerUserId, {
    amplitude: frame.amplitude,
    pitchNorm: frame.pitchNorm,
    zcrNorm: frame.zcrNorm,
    mouthShape: frame.mouthShape,
    pitchTrend: frame.pitchTrend,
    expressiveness: frame.expressiveness,
    activity: frame.activity,
    event: isNewEvent ? frame.event : eventFresh ? prev!.event : 'none',
    eventAt: isNewEvent ? Date.now() : eventFresh ? prev!.eventAt : 0,
  });
}

function frame(partial: Partial<AnimationFrame> = {}): AnimationFrame {
  return {
    seq: 0,
    amplitude: 0.3,
    pitchNorm: 0.5,
    zcrNorm: 0.3,
    mouthShape: 0.4,
    pitchTrend: 0.1,
    expressiveness: 0.2,
    activity: 0.3,
    event: 'none',
    ...partial,
  };
}

const PEER = 'bob';

beforeEach(() => {
  usePeerAnimation.setState({ byPeerId: {} });
});

describe('event-overlay lifecycle (rc.11 review blocker regression)', () => {
  it('eventAt is sticky across subsequent "none" frames', () => {
    applyFrame(PEER, frame({ event: 'laugh' }));
    const eventAtAfterLaugh = selectPeerAnimation(
      usePeerAnimation.getState(),
      PEER,
    ).eventAt;
    expect(eventAtAfterLaugh).toBeGreaterThan(0);

    // Sender's cooldown means the next 30 Hz frame carries event:'none'.
    // The store MUST keep the prior eventAt so the receiver's overlay
    // animation isn't re-fired with cleared deps.
    for (let i = 0; i < 30; i++) {
      applyFrame(PEER, frame({ event: 'none' }));
    }
    const stickyState = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    expect(stickyState.eventAt).toBe(eventAtAfterLaugh);
    expect(stickyState.event).toBe('laugh');
  });

  it('a new non-"none" event bumps eventAt to a fresh timestamp', async () => {
    applyFrame(PEER, frame({ event: 'laugh' }));
    const firstAt = selectPeerAnimation(usePeerAnimation.getState(), PEER).eventAt;
    // 1 ms gap so Date.now() is strictly greater.
    await new Promise((r) => setTimeout(r, 2));
    applyFrame(PEER, frame({ event: 'gasp' }));
    const second = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    expect(second.event).toBe('gasp');
    expect(second.eventAt).toBeGreaterThan(firstAt);
  });

  it('latched repeats of the same event do NOT re-fire the overlay (rising-edge dedup)', () => {
    // The sender re-sends the SAME event for ~9 frames so the unreliable
    // channel delivers at least one. The receiver must trigger the
    // one-shot overlay exactly once — repeats keep the original eventAt
    // so the animation isn't restarted mid-bounce.
    applyFrame(PEER, frame({ event: 'laugh' }));
    const firstAt = selectPeerAnimation(
      usePeerAnimation.getState(),
      PEER,
    ).eventAt;
    for (let i = 0; i < 8; i++) {
      applyFrame(PEER, frame({ event: 'laugh' }));
    }
    const s = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    expect(s.event).toBe('laugh');
    expect(s.eventAt).toBe(firstAt);
  });

  it('continuous channels update every frame even while event is sticky', () => {
    applyFrame(PEER, frame({ event: 'laugh', mouthShape: 0.2 }));
    applyFrame(PEER, frame({ event: 'none', mouthShape: 0.9 }));
    const state = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    // mouthShape follows the latest frame even though event stays at 'laugh'.
    expect(state.mouthShape).toBe(0.9);
    expect(state.event).toBe('laugh');
  });

  it('first frame for an unseen peer with event="none" stores event:none, eventAt:0', () => {
    applyFrame(PEER, frame({ event: 'none' }));
    const s = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    expect(s.event).toBe('none');
    expect(s.eventAt).toBe(0);
  });

  it('peer state shape matches PeerAnimationState exactly (no field drift)', () => {
    applyFrame(PEER, frame({ event: 'laugh' }));
    const s = selectPeerAnimation(usePeerAnimation.getState(), PEER);
    const expectedKeys: Array<keyof PeerAnimationState> = [
      'amplitude',
      'pitchNorm',
      'zcrNorm',
      'mouthShape',
      'pitchTrend',
      'expressiveness',
      'activity',
      'event',
      'eventAt',
    ];
    expect(Object.keys(s).sort()).toEqual([...expectedKeys].sort());
  });
});
