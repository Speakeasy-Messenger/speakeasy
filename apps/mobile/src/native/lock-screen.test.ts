import { describe, expect, it } from 'vitest';
import { setShowWhenLocked, shouldShowOverLockScreen } from './lock-screen.js';

describe('shouldShowOverLockScreen', () => {
  // The bug this guards: showWhenLocked used to be a static manifest flag,
  // so the app showed over the lock screen for EVERY stage (incl. no call),
  // leaking the chat list on a locked device. The predicate must be true
  // ONLY for live calls.
  it('is false with no active call', () => {
    expect(shouldShowOverLockScreen(undefined)).toBe(false);
  });

  it('is false for idle and ended', () => {
    expect(shouldShowOverLockScreen('idle')).toBe(false);
    expect(shouldShowOverLockScreen('ended')).toBe(false);
  });

  it('is true for every live call stage', () => {
    for (const stage of [
      'outgoing_dialing',
      'outgoing_ringing',
      'incoming_ringing',
      'connecting',
      'connected',
    ]) {
      expect(shouldShowOverLockScreen(stage)).toBe(true);
    }
  });
});

describe('setShowWhenLocked', () => {
  it('no-ops safely when the native module is absent (non-Android test env)', () => {
    expect(() => setShowWhenLocked(true)).not.toThrow();
    expect(() => setShowWhenLocked(false)).not.toThrow();
  });
});
