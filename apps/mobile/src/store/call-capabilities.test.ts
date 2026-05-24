import { describe, expect, it, beforeEach } from 'vitest';
import { useCallCapabilities } from './call-capabilities.js';

describe('useCallCapabilities', () => {
  beforeEach(() => {
    useCallCapabilities.setState({ byUserId: {}, hydrated: false });
  });

  it('set + supports returns true for stored kinds', () => {
    useCallCapabilities.getState().set('bob', ['audio', 'video', 'private']);
    expect(useCallCapabilities.getState().supports('bob', 'private')).toBe(true);
    expect(useCallCapabilities.getState().supports('bob', 'audio')).toBe(true);
  });

  it('supports returns false for an unknown peer', () => {
    expect(useCallCapabilities.getState().supports('nobody', 'private')).toBe(false);
  });

  it('supports returns false when peer set excludes the kind', () => {
    useCallCapabilities.getState().set('bob', ['audio', 'video']);
    expect(useCallCapabilities.getState().supports('bob', 'private')).toBe(false);
  });

  it('set drops unknown kinds (defense in depth against a future server)', () => {
    useCallCapabilities
      .getState()
      .set('bob', ['audio', 'video', 'private', 'holographic']);
    expect(useCallCapabilities.getState().byUserId.bob?.kinds).toEqual([
      'audio',
      'video',
      'private',
    ]);
  });

  it('isFresh distinguishes recent vs stale entries via TTL', () => {
    useCallCapabilities.getState().set('bob', ['audio']);
    expect(useCallCapabilities.getState().isFresh('bob')).toBe(true);
    // Force stale by reaching past the 15-min TTL.
    useCallCapabilities.setState((s) => ({
      byUserId: {
        ...s.byUserId,
        bob: { kinds: ['audio'], fetchedAt: Date.now() - 16 * 60 * 1000 },
      },
    }));
    expect(useCallCapabilities.getState().isFresh('bob')).toBe(false);
  });

  it('isFresh returns false for unknown peer', () => {
    expect(useCallCapabilities.getState().isFresh('nobody')).toBe(false);
  });
});
