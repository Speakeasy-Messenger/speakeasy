import { describe, expect, it } from 'vitest';
import {
  isIgnoringBatteryOptimizations,
  requestDisableBatteryOptimization,
} from './power.js';

describe('isIgnoringBatteryOptimizations', () => {
  // Off-Android (iOS, vitest, web) there's no battery-optimization concept
  // and no native module, so it resolves `true` — "already handled" — and
  // the in-app nudge never shows on a platform that can't act on it.
  it('resolves true when the native module is absent (non-Android test env)', async () => {
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true);
  });
});

describe('requestDisableBatteryOptimization', () => {
  it('resolves false when the native module is absent (non-Android test env)', async () => {
    await expect(requestDisableBatteryOptimization()).resolves.toBe(false);
  });
});
