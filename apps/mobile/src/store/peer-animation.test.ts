import { describe, expect, it, beforeEach } from 'vitest';
import {
  selectPeerAnimation,
  usePeerAnimation,
} from './peer-animation.js';

describe('usePeerAnimation', () => {
  beforeEach(() => {
    usePeerAnimation.setState({ byPeerId: {} });
  });

  it('starts empty; selectors return a neutral default', () => {
    const s = usePeerAnimation.getState();
    expect(s.byPeerId).toEqual({});
    expect(selectPeerAnimation(s, 'bob')).toEqual({
      amplitude: 0,
      emotionState: 'baseline',
      pitchNorm: 0,
      zcrNorm: 0,
    });
  });

  it('set stores per-peer state', () => {
    usePeerAnimation.getState().set('bob', {
      amplitude: 0.7,
      emotionState: 'excited',
      pitchNorm: 0.8,
      zcrNorm: 0.4,
    });
    expect(selectPeerAnimation(usePeerAnimation.getState(), 'bob')).toEqual({
      amplitude: 0.7,
      emotionState: 'excited',
      pitchNorm: 0.8,
      zcrNorm: 0.4,
    });
  });

  it('keeps multiple peers independent', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', {
      amplitude: 0.5,
      emotionState: 'excited',
      pitchNorm: 0.5,
      zcrNorm: 0.5,
    });
    api.set('carol', {
      amplitude: 0.2,
      emotionState: 'calm',
      pitchNorm: 0.2,
      zcrNorm: 0.8,
    });
    const s = usePeerAnimation.getState();
    expect(selectPeerAnimation(s, 'bob').emotionState).toBe('excited');
    expect(selectPeerAnimation(s, 'carol').emotionState).toBe('calm');
  });

  it('clear drops a single peer', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', {
      amplitude: 0.5,
      emotionState: 'excited',
      pitchNorm: 0.5,
      zcrNorm: 0.5,
    });
    api.set('carol', {
      amplitude: 0.2,
      emotionState: 'calm',
      pitchNorm: 0.2,
      zcrNorm: 0.8,
    });
    api.clear('bob');
    expect(usePeerAnimation.getState().byPeerId.bob).toBeUndefined();
    expect(usePeerAnimation.getState().byPeerId.carol).toBeDefined();
  });

  it('reset drops everything', () => {
    const api = usePeerAnimation.getState();
    api.set('bob', {
      amplitude: 0.5,
      emotionState: 'excited',
      pitchNorm: 0.5,
      zcrNorm: 0.5,
    });
    api.reset();
    expect(usePeerAnimation.getState().byPeerId).toEqual({});
  });
});
