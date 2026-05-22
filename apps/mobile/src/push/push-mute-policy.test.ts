import { describe, expect, it } from 'vitest';
import { shouldSuppressPushForMute } from './push-mute-policy.js';
import type { ConversationState } from '../store/conversations.js';

function conv(muted: boolean | undefined): ConversationState {
  return {
    kind: 'direct',
    createdAt: 1,
    messages: [],
    ttl: 'week',
    persistenceEnabled: false,
    muted,
  };
}

describe('shouldSuppressPushForMute', () => {
  it('suppresses a push only when the hydrated target conversation is muted', () => {
    expect(
      shouldSuppressPushForMute('c1', {
        hydrated: true,
        byId: { c1: conv(true) },
      }),
    ).toBe(true);
  });

  it('does not suppress when the store is not hydrated', () => {
    expect(
      shouldSuppressPushForMute('c1', {
        hydrated: false,
        byId: { c1: conv(true) },
      }),
    ).toBe(false);
  });

  it('does not suppress a different or unmuted conversation', () => {
    expect(
      shouldSuppressPushForMute('c2', {
        hydrated: true,
        byId: { c1: conv(true), c2: conv(false) },
      }),
    ).toBe(false);
  });
});
