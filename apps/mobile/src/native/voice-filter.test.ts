import { describe, expect, it } from 'vitest';
import { decidePrivateCallAvailable } from './voice-filter.js';

// The live isPrivateCallAvailable() reads react-native via a lazy require that
// throws under vitest, so the platform/availability logic is tested through the
// pure decidePrivateCallAvailable() it delegates to.
describe('decidePrivateCallAvailable', () => {
  it('is available on Android when the native module reports ready', () => {
    expect(decidePrivateCallAvailable('android', true)).toBe(true);
  });

  it('is FALSE on iOS even when native reports ready (fail-safe: the masking ADM is disabled; a Private call would leak the real voice)', () => {
    expect(decidePrivateCallAvailable('ios', true)).toBe(false);
  });

  it('is false on Android when native reports not-ready', () => {
    expect(decidePrivateCallAvailable('android', false)).toBe(false);
  });

  it('is false on unsupported platforms regardless of availability', () => {
    expect(decidePrivateCallAvailable('web', true)).toBe(false);
    expect(decidePrivateCallAvailable('macos', true)).toBe(false);
  });
});
