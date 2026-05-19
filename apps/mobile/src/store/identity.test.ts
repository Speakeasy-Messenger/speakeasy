import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isEnrolled, useIdentity } from './identity.js';

const STORAGE_KEY = 'speakeasy.identity.v1';

/** Let the store's fire-and-forget `persist()` writes settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await useIdentity.getState().reset();
});

describe('useIdentity', () => {
  it('starts with no userId', () => {
    expect(useIdentity.getState().userId).toBeUndefined();
    expect(isEnrolled(useIdentity.getState())).toBe(false);
  });

  it('setUserId flips to enrolled', () => {
    useIdentity.getState().setUserId('silent-golden-hawk');
    expect(useIdentity.getState().userId).toBe('silent-golden-hawk');
    expect(isEnrolled(useIdentity.getState())).toBe(true);
  });

  it('reset clears userId', () => {
    useIdentity.getState().setUserId('a-b-c');
    useIdentity.getState().reset();
    expect(useIdentity.getState().userId).toBeUndefined();
  });
});

describe('useIdentity — device token never persisted to AsyncStorage', () => {
  it('persists userId but never the deviceToken', async () => {
    useIdentity.getState().setUserId('quiet-amber-fox');
    useIdentity.getState().setDeviceToken('dvt_live_supersecret_must_not_persist');
    await flush();

    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('supersecret');
    const parsed = JSON.parse(raw as string);
    expect(parsed.userId).toBe('quiet-amber-fox');
    expect(parsed.deviceToken).toBeUndefined();
    // The non-secret freshness timestamp is still persisted.
    expect(typeof parsed.deviceTokenIssuedAt).toBe('number');

    // The in-memory working copy is still set for the session.
    expect(useIdentity.getState().deviceToken).toBe(
      'dvt_live_supersecret_must_not_persist',
    );
  });

  it('hydrate() scrubs a legacy cleartext deviceToken from AsyncStorage', async () => {
    // A pre-migration build wrote the token here in cleartext.
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        userId: 'legacy-user',
        deviceToken: 'dvt_legacy_cleartext_token',
        deviceTokenIssuedAt: 123,
      }),
    );

    await useIdentity.getState().hydrate();
    await flush();

    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(raw).not.toContain('dvt_legacy_cleartext_token');
    const parsed = JSON.parse(raw as string);
    expect(parsed.deviceToken).toBeUndefined();
    // Non-secret fields survive the scrub.
    expect(parsed.userId).toBe('legacy-user');
    expect(parsed.deviceTokenIssuedAt).toBe(123);
  });
});
