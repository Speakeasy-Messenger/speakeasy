import { describe, expect, it } from 'vitest';
import {
  decidePrivateCallAvailable,
  decideOutboundMaskActive,
} from './voice-filter.js';

// The live wrappers read react-native via a lazy require that throws under
// vitest, so the logic is tested through the pure decide* functions.
describe('decidePrivateCallAvailable (can the private call CONNECT)', () => {
  it('is available on Android when native reports ready', () => {
    expect(decidePrivateCallAvailable('android', true)).toBe(true);
  });

  it('is available on iOS — the call connects (unmasked iOS leg), the prior working behavior', () => {
    // Regression guard: the build-16 fail-safe returned false here, which made
    // the orchestrator FAIL the call on accept — killing the only voice-call
    // type on iOS. The call must connect; masking honesty is a separate signal.
    expect(decidePrivateCallAvailable('ios', true)).toBe(true);
  });

  it('is false when native reports not-ready', () => {
    expect(decidePrivateCallAvailable('android', false)).toBe(false);
    expect(decidePrivateCallAvailable('ios', false)).toBe(false);
  });

  it('is false on unsupported platforms', () => {
    expect(decidePrivateCallAvailable('web', true)).toBe(false);
  });
});

describe('decideOutboundMaskActive (is the local voice ACTUALLY masked)', () => {
  it('is true on Android (capture fork masks the mic)', () => {
    expect(decideOutboundMaskActive('android', true)).toBe(true);
  });

  it('is FALSE on iOS even when the call is available (ADM disabled — iOS leg rides unmasked)', () => {
    expect(decideOutboundMaskActive('ios', true)).toBe(false);
  });

  it('is false on Android when native is not ready', () => {
    expect(decideOutboundMaskActive('android', false)).toBe(false);
  });
});
