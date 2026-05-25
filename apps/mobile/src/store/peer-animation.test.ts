import { describe, expect, it, beforeEach } from 'vitest';
import {
  selectPeerAnimation,
  usePeerAnimation,
  type PeerAnimationState,
} from './peer-animation.js';

/** Shorthand factory for a peer-animation state with the full v2
 *  prosody shape — keeps individual `set()` calls in the tests short
 *  by spreading neutral defaults underneath. */
function p(partial: Partial<PeerAnimationState> = {}): PeerAnimationState {
  return {
    amplitude: 0,
    pitchNorm: 0,
    zcrNorm: 0,
    mouthShape: 0,
    pitchTrend: 0,
    expressiveness: 0,
    activity: 0,
    event: 'none',
    eventAt: 0,
    ...partial,
  };
}

describe('usePeerAnimation', () => {
  beforeEach(() => {
    usePeerAnimation.setState({ byPeerId: {} });
  });

  it('starts empty; selectors return a neutral default', () => {
    const s = usePeerAnimation.getState();
    expect(s.byPeerId).toEqual({});
    expect(selectPeerAnimation(s, 'bob')).toEqual(p());
  });

  it('set stores per-peer state', () => {
    usePeerAnimation.getState().set(
      'bob',
      p({
        amplitude: 0.7,
        pitchNorm: 0.8,
        mouthShape: 0.6,
        pitchTrend: 0.4,
        expressiveness: 0.5,
        activity: 0.3,
      }),
    );
    const stored = selectPeerAnimation(usePeerAnimation.getState(), 'bob');
    expect(stored.amplitude).toBe(0.7);
    expect(stored.mouthShape).toBe(0.6);
    expect(stored.pitchTrend).toBe(0.4);
    expect(stored.event).toBe('none');
  });

  it('keeps multiple peers independent', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', p({ amplitude: 0.5, pitchTrend: 0.5 }));
    api.set('carol', p({ amplitude: 0.2, pitchTrend: -0.6 }));
    const s = usePeerAnimation.getState();
    expect(selectPeerAnimation(s, 'bob').pitchTrend).toBe(0.5);
    expect(selectPeerAnimation(s, 'carol').pitchTrend).toBe(-0.6);
  });

  it('clear drops a single peer', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', p({ amplitude: 0.5 }));
    api.set('carol', p({ amplitude: 0.2 }));
    api.clear('bob');
    expect(usePeerAnimation.getState().byPeerId.bob).toBeUndefined();
    expect(usePeerAnimation.getState().byPeerId.carol).toBeDefined();
  });

  it('reset drops everything', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', p({ amplitude: 0.5 }));
    api.reset();
    expect(usePeerAnimation.getState().byPeerId).toEqual({});
  });

  it('carries acoustic events with their receive timestamp', () => {
    usePeerAnimation.getState().set(
      'bob',
      p({ event: 'laugh', eventAt: 12345 }),
    );
    const stored = selectPeerAnimation(usePeerAnimation.getState(), 'bob');
    expect(stored.event).toBe('laugh');
    expect(stored.eventAt).toBe(12345);
  });
});
