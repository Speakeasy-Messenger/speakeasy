import { beforeEach, describe, expect, it } from 'vitest';
// vitest.config.ts aliases this to src/__mocks__/async-storage.ts so
// both this test and wipe.ts share the same in-memory instance.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { wipeAllPersistedState } from './wipe.js';

describe('wipeAllPersistedState', () => {
  beforeEach(() => {
    __resetAsyncStorageMock();
  });

  it('removes every key prefixed with speakeasy.', async () => {
    await AsyncStorage.setItem('speakeasy.identity.v1', '{"userId":"x"}');
    await AsyncStorage.setItem('speakeasy.conversations.v1', '{}');
    await AsyncStorage.setItem('speakeasy.profiles.v2', '{}');

    await wipeAllPersistedState();

    expect(await AsyncStorage.getItem('speakeasy.identity.v1')).toBeNull();
    expect(await AsyncStorage.getItem('speakeasy.conversations.v1')).toBeNull();
    expect(await AsyncStorage.getItem('speakeasy.profiles.v2')).toBeNull();
  });

  it('removes every key prefixed with speakeasy- (legacy kebab-case)', async () => {
    // store/blocks.ts, store/distribution-ids.ts, store/groups.ts use
    // the kebab-case prefix. Catch them too.
    await AsyncStorage.setItem('speakeasy-blocks', '{}');
    await AsyncStorage.setItem('speakeasy-distribution-ids', '{}');
    await AsyncStorage.setItem('speakeasy-groups', '{}');

    await wipeAllPersistedState();

    expect(await AsyncStorage.getItem('speakeasy-blocks')).toBeNull();
    expect(await AsyncStorage.getItem('speakeasy-distribution-ids')).toBeNull();
    expect(await AsyncStorage.getItem('speakeasy-groups')).toBeNull();
  });

  it('leaves non-Speakeasy keys alone', async () => {
    // Other libraries on the device may share AsyncStorage. We must
    // not touch their data — wiping `speakeasy.*` is enough to fix
    // the ghost-identity bug.
    await AsyncStorage.setItem('vouchflow.sdk.cache', '{}');
    await AsyncStorage.setItem('expo.something', '{}');
    await AsyncStorage.setItem('speakeasy.identity.v1', '{}');

    await wipeAllPersistedState();

    expect(await AsyncStorage.getItem('vouchflow.sdk.cache')).toBe('{}');
    expect(await AsyncStorage.getItem('expo.something')).toBe('{}');
    expect(await AsyncStorage.getItem('speakeasy.identity.v1')).toBeNull();
  });

  it('is a no-op when nothing matches', async () => {
    await AsyncStorage.setItem('unrelated', '{}');
    await wipeAllPersistedState();
    expect(await AsyncStorage.getItem('unrelated')).toBe('{}');
  });
});
