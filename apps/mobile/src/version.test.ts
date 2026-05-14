import { describe, expect, it } from 'vitest';
import { appVersion, appBuild } from './version.js';

describe('version', () => {
  it('appVersion() reads versionName from the SpeakeasyVersion native module', () => {
    // The vitest mock for react-native (src/__mocks__/react-native.ts)
    // provides SpeakeasyVersion = { versionName: '0.0.0-test',
    // versionCode: 0 }. If this assertion ever breaks, either the
    // module wiring regressed or the test mock changed shape.
    expect(appVersion()).toBe('0.0.0-test');
  });

  it('appBuild() reads versionCode from the SpeakeasyVersion native module as a string', () => {
    // versionCode is an integer on the native side; we stringify in
    // version.ts because every consumer (feedback payload, About
    // screen footer) expects a string. Regression guard for that
    // boundary conversion.
    expect(appBuild()).toBe('0');
    expect(typeof appBuild()).toBe('string');
  });
});
