import { beforeEach, describe, expect, it } from 'vitest';
import { useSettings } from './settings.js';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';

beforeEach(async () => {
  __resetAsyncStorageMock();
  await useSettings.getState().reset();
});

describe('useSettings', () => {
  it('defaults inAppNotificationsEnabled to true', () => {
    expect(useSettings.getState().inAppNotificationsEnabled).toBe(true);
  });

  it('persists the toggle and re-reads it on hydrate', async () => {
    useSettings.getState().setInAppNotificationsEnabled(false);
    await Promise.resolve(); // let the persist promise settle

    // Simulate cold start: clear in-memory state, then hydrate from disk.
    useSettings.setState({ inAppNotificationsEnabled: true, hydrated: false });
    await useSettings.getState().hydrate();
    expect(useSettings.getState().inAppNotificationsEnabled).toBe(false);
    expect(useSettings.getState().hydrated).toBe(true);
  });

  it('hydrate keeps defaults when nothing is persisted', async () => {
    await useSettings.getState().hydrate();
    expect(useSettings.getState().inAppNotificationsEnabled).toBe(true);
  });
});
