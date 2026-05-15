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

  it('creates the row when userId is supplied and the deviceToken has not been upsertOnSeen yet (wipe-and-recover race)', async () => {
    // tester15 incident, 2026-05-14. Reproduction sequence:
    //   1. Mobile cold-launches under cached Vouchflow deviceToken
    //      `dvt_OLD`. WS handshake → upsertOnSeen(dvt_OLD, tester15).
    //   2. Mobile registers FCM token T under dvt_OLD → row holds T.
    //   3. Vouchflow identity recovery probes and gets back a FRESH
    //      deviceToken `dvt_NEW` for the same physical device.
    //   4. Mobile re-registers FCM token T under dvt_NEW BEFORE the
    //      WS handshake has had a chance to upsertOnSeen(dvt_NEW).
    //
    // Pre-rc.92 bug: step 4's rotation nulled dvt_OLD's push_token,
    // the silent-no-op UPDATE for dvt_NEW matched zero rows, and
    // tester15 was left with zero devices holding T. Every message
    // → push.no_devices (no FCM call made), no banner.
    //
    // Post-rc.92: setPushToken with userId creates the missing row
    // (insert-on-conflict), so after step 4 there is at least one
    // row owned by tester15 holding T.
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({ deviceToken: 'dvt_OLD', userId: 'tester15' });
    await repo.setPushToken({
      deviceToken: 'dvt_OLD',
      userId: 'tester15',
      pushToken: 'fcm-T',
      platform: 'android',
    });
    // Sanity: row is registered.
    expect(
      (await repo.listForUser('tester15'))
        .filter((d) => d.pushToken === 'fcm-T'),
    ).toHaveLength(1);

    // Identity recovery hands back a new Vouchflow deviceToken; the
    // HTTP push-token POST lands BEFORE the WS handshake has had a
    // chance to upsertOnSeen it. Crucially: NO upsertOnSeen here.
    await repo.setPushToken({
      deviceToken: 'dvt_NEW',
      userId: 'tester15',
      pushToken: 'fcm-T',
      platform: 'android',
    });

    // After the call there MUST be at least one row for tester15
    // holding the live FCM token. Without this guarantee
    // listForUser → filter(pushToken) returns empty and
    // FcmApnsPushProvider short-circuits to `push.no_devices`.
    const live = (await repo.listForUser('tester15')).filter(
      (d) => d.pushToken === 'fcm-T',
    );
    expect(live.length).toBeGreaterThanOrEqual(1);
    // And the row that owns the live token is the NEW one (latest
    // registration wins — FCM tokens are device-installation-scoped
    // so the most recent setPushToken call is authoritative).
    expect(live.some((d) => d.deviceToken === 'dvt_NEW')).toBe(true);
  });

  it('silently no-ops on missing row when userId is omitted (legacy contract)', async () => {
    // Existing WS handler + tests pair upsertOnSeen + setPushToken,
    // so the legacy contract (no userId → silent no-op when row
    // missing) must keep working. Locks in the backward-compat
    // boundary so a future refactor does not accidentally upgrade
    // legacy callers into surprise inserts.
    const repo = new InMemoryDevicesRepo();
    await repo.setPushToken({
      deviceToken: 'dvt_never_seen',
      pushToken: 'fcm-T',
      platform: 'android',
    });
    // No row should have been created.
    expect([...repo.devices.keys()]).toHaveLength(0);
  });

  it('clearPushToken nulls push_token on every row holding it and records the reason', async () => {
    // When FCM returns UNREGISTERED for a token, the provider calls
    // clearPushToken so subsequent notifyDelivery short-circuits
    // before we burn FCM quota and rack up phantom successes. Two
    // rows can hold the same token transiently during reinstall
    // (rc.80 rotation handles steady-state), so the clear must be
    // applied by push_token, not by deviceToken.
    const repo = new InMemoryDevicesRepo();
    await repo.upsertOnSeen({ deviceToken: 'dvt_a', userId: 'alice' });
    await repo.upsertOnSeen({ deviceToken: 'dvt_b', userId: 'bob' });
    await repo.setPushToken({
      deviceToken: 'dvt_a',
      pushToken: 'fcm-shared',
      platform: 'android',
    });
    // Force a second row to hold the same token without invoking the
    // rotation (simulating the pre-rc.92 race that left two rows
    // holding the same token).
    repo.devices.get('dvt_b')!.pushToken = 'fcm-shared';

    await repo.clearPushToken({
      pushToken: 'fcm-shared',
      reason: 'fcm:messaging/registration-token-not-registered',
    });

    const a = (await repo.listForUser('alice'))[0]!;
    const b = (await repo.listForUser('bob'))[0]!;
    expect(a.pushToken).toBeUndefined();
    expect(b.pushToken).toBeUndefined();
    expect(a.lastPushError).toBe(
      'fcm:messaging/registration-token-not-registered',
    );
    expect(b.lastPushError).toBe(
      'fcm:messaging/registration-token-not-registered',
    );
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
