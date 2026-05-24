import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { devices } from './schema.js';
import type { DeviceRecord, DevicesRepo, NotificationPrivacy } from './devices.js';

export class DrizzleDevicesRepo implements DevicesRepo {
  async upsertOnSeen(args: {
    deviceToken: string;
    userId: string;
  }): Promise<void> {
    const db = getDb();
    await db
      .insert(devices)
      .values({
        deviceToken: args.deviceToken,
        userId: args.userId,
      })
      .onConflictDoUpdate({
        target: [devices.deviceToken],
        set: { lastSeen: sql`now()` },
      });
  }

  async listForUser(userId: string): Promise<DeviceRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId));
    return rows.map((r) => ({
      deviceToken: r.deviceToken,
      userId: r.userId,
      pushToken: r.pushToken ?? undefined,
      platform: (r.platform as 'ios' | 'android') ?? undefined,
      notificationPrivacy:
        (r.notificationPrivacy as NotificationPrivacy | null) ?? undefined,
      lastPushError: r.lastPushError ?? undefined,
      supportedCallKinds: r.supportedCallKinds ?? undefined,
      enrolledAt: r.enrolledAt,
      lastSeen: r.lastSeen,
    }));
  }

  async listActiveUserIds(maxAgeMs: number): Promise<string[]> {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxAgeMs);
    const rows = await db
      .selectDistinct({ userId: devices.userId })
      .from(devices)
      .where(gte(devices.lastSeen, cutoff));
    return rows.map((r) => r.userId);
  }

  async remove(deviceToken: string): Promise<'removed' | 'not_found'> {
    const db = getDb();
    const deleted = await db
      .delete(devices)
      .where(eq(devices.deviceToken, deviceToken))
      .returning({ deviceToken: devices.deviceToken });
    return deleted.length > 0 ? 'removed' : 'not_found';
  }

  async setPushToken(args: {
    deviceToken: string;
    pushToken: string;
    platform: 'ios' | 'android';
    notificationPrivacy?: NotificationPrivacy;
    userId?: string;
  }): Promise<void> {
    const db = getDb();
    const set: Record<string, unknown> = {
      pushToken: args.pushToken,
      platform: args.platform,
      // Clear any previous error on successful registration.
      lastPushError: null,
    };
    // Only overwrite the privacy column when the caller actually
    // supplied one — see DevicesRepo.setPushToken contract.
    if (args.notificationPrivacy !== undefined) {
      set.notificationPrivacy = args.notificationPrivacy;
    }
    // rc.80 (the rotation): FCM tokens are device-installation-scoped,
    // not user-scoped. If the same physical device reinstalls the app
    // and onboards as a different userId, Google re-issues the SAME
    // FCM token but binds it (via the new Vouchflow deviceToken) to
    // the new user row. Without this rotation, the OLD device row
    // keeps the FCM token too — and the next push to the old userId
    // wakes up the device that now belongs to the new userId, leaking
    // metadata across identities.
    //
    // Concrete repro (rc.79 test cycle): tester9 reinstalls →
    // becomes tester13 with FCM `d-44a4EE…`. Both device rows held
    // that same FCM token. Any push for tester9 would have surfaced
    // on tester13's lockscreen as "@<sender>: New message".
    //
    // rc.92 (the ordering + insert): the rc.80 transaction had a
    // latent bug — UPDATE-then-UPDATE silently no-ops when the target
    // deviceToken has no row yet. That is exactly what happens during
    // Vouchflow wipe-and-recover: the mobile app POSTs
    // /v1/devices/push-token under a freshly-minted deviceToken
    // BEFORE the WS handshake has had a chance to `upsertOnSeen` it.
    // The rotation clause then nulls the OLD row's push_token, the
    // second UPDATE matches zero rows, and the user is left with
    // ZERO devices holding the live token. Every subsequent
    // `notifyDelivery` short-circuits to `push.no_devices` —
    // exactly tester15's 2026-05-14 incident.
    //
    // The fix has two halves:
    //
    //   1. Insert-on-conflict the target row FIRST, so by the time
    //      the rotation runs we're guaranteed at least one row owned
    //      by this user holds the live token. Requires `userId`; for
    //      backward compatibility (tests, WS handler that paired
    //      upsertOnSeen+setPushToken historically) we keep the
    //      legacy UPDATE-then-UPDATE path when userId is omitted.
    //
    //   2. Run the rotation AFTER the target write so we never have a
    //      window with zero rows holding the token.
    //
    // Wrapped in a transaction so concurrent /devices/push-token
    // calls can't interleave a NULL between halves.
    await db.transaction(async (tx) => {
      if (args.userId !== undefined) {
        // New path: target row is guaranteed to exist after this.
        await tx
          .insert(devices)
          .values({
            deviceToken: args.deviceToken,
            userId: args.userId,
            pushToken: args.pushToken,
            platform: args.platform,
            notificationPrivacy: args.notificationPrivacy ?? null,
            lastPushError: null,
          })
          .onConflictDoUpdate({
            target: devices.deviceToken,
            set,
          });
      } else {
        // Legacy path: row must exist; missing row is a silent no-op
        // (preserves pre-rc.92 behavior for tests + WS handler).
        await tx
          .update(devices)
          .set(set)
          .where(eq(devices.deviceToken, args.deviceToken));
      }
      // Rotation comes AFTER the target write — see header comment.
      await tx
        .update(devices)
        .set({ pushToken: null })
        .where(
          and(
            eq(devices.pushToken, args.pushToken),
            ne(devices.deviceToken, args.deviceToken),
          ),
        );
    });
  }

  async reportPushError(args: { deviceToken: string; error: string }): Promise<void> {
    const db = getDb();
    await db
      .update(devices)
      .set({ lastPushError: args.error })
      .where(eq(devices.deviceToken, args.deviceToken));
  }

  async clearPushToken(args: { pushToken: string; reason: string }): Promise<void> {
    const db = getDb();
    await db
      .update(devices)
      .set({ pushToken: null, lastPushError: args.reason })
      .where(eq(devices.pushToken, args.pushToken));
  }

  async setSupportedCallKinds(args: {
    deviceToken: string;
    kinds: readonly string[];
  }): Promise<void> {
    const db = getDb();
    await db
      .update(devices)
      // Mutable copy — drizzle types reject readonly string[].
      .set({ supportedCallKinds: [...args.kinds] })
      .where(eq(devices.deviceToken, args.deviceToken));
  }
}
