import { describe, expect, it } from 'vitest';
import { InMemoryDevicesRepo } from './devices.memory.js';

describe('DevicesRepo.setPushToken — FCM token rotation', () => {
  it('moves the FCM token off any other device row that currently holds it', async () => {
    // rc.80 ghost-push bug: same physical device reinstalls the app
    // and onboards as a different userId. Google re-issues the same
    // FCM token. Without rotation, both device rows claim it, and
    // pushes for the prior userId surface on the new userId's
    // lockscreen (metadata leak).
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({
      deviceToken: 'dvt_old',
      userId: 'tester9-xxx',
    });
    await repo.setPushToken({
      deviceToken: 'dvt_old',
      pushToken: 'fcm-shared-installation-token',
      platform: 'android',
    });

    // Same device reinstalls, onboards as a new user, new
    // deviceToken — and re-registers the same FCM token.
    await repo.upsertOnSeen({
      deviceToken: 'dvt_new',
      userId: 'tester13-yyy',
    });
    await repo.setPushToken({
      deviceToken: 'dvt_new',
      pushToken: 'fcm-shared-installation-token',
      platform: 'android',
    });

    const oldUserDevices = await repo.listForUser('tester9-xxx');
    expect(oldUserDevices).toHaveLength(1);
    expect(oldUserDevices[0]!.pushToken).toBeUndefined();

    const newUserDevices = await repo.listForUser('tester13-yyy');
    expect(newUserDevices).toHaveLength(1);
    expect(newUserDevices[0]!.pushToken).toBe('fcm-shared-installation-token');
  });

  it('does not touch other rows when the FCM token is unique', async () => {
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({ deviceToken: 'dvt_a', userId: 'alice' });
    await repo.upsertOnSeen({ deviceToken: 'dvt_b', userId: 'bob' });
    await repo.setPushToken({
      deviceToken: 'dvt_a',
      pushToken: 'fcm-alice',
      platform: 'android',
    });
    await repo.setPushToken({
      deviceToken: 'dvt_b',
      pushToken: 'fcm-bob',
      platform: 'android',
    });

    const aliceDevices = await repo.listForUser('alice');
    expect(aliceDevices[0]!.pushToken).toBe('fcm-alice');
    const bobDevices = await repo.listForUser('bob');
    expect(bobDevices[0]!.pushToken).toBe('fcm-bob');
  });

  it('is idempotent — re-registering the same token on the same device is a no-op for other rows', async () => {
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({ deviceToken: 'dvt_a', userId: 'alice' });
    await repo.upsertOnSeen({ deviceToken: 'dvt_b', userId: 'bob' });
    await repo.setPushToken({
      deviceToken: 'dvt_a',
      pushToken: 'fcm-a',
      platform: 'android',
    });
    await repo.setPushToken({
      deviceToken: 'dvt_b',
      pushToken: 'fcm-b',
      platform: 'android',
    });
    // Re-register alice's existing token — must NOT clear bob's
    // unrelated token.
    await repo.setPushToken({
      deviceToken: 'dvt_a',
      pushToken: 'fcm-a',
      platform: 'android',
    });

    const aliceDevices = await repo.listForUser('alice');
    expect(aliceDevices[0]!.pushToken).toBe('fcm-a');
    const bobDevices = await repo.listForUser('bob');
    expect(bobDevices[0]!.pushToken).toBe('fcm-b');
  });

  it('clears lastPushError on successful re-registration', async () => {
    // Pre-existing behavior, locked in as a regression guard since
    // the rotation logic now lives alongside the error-clear logic.
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({ deviceToken: 'dvt_a', userId: 'alice' });
    await repo.reportPushError({
      deviceToken: 'dvt_a',
      error: 'android_post_notifications_denied',
    });
    expect(
      (await repo.listForUser('alice'))[0]!.lastPushError,
    ).toBe('android_post_notifications_denied');

    await repo.setPushToken({
      deviceToken: 'dvt_a',
      pushToken: 'fcm-a',
      platform: 'android',
    });
    expect(
      (await repo.listForUser('alice'))[0]!.lastPushError,
    ).toBeUndefined();
  });
});
