import { eq, sql } from 'drizzle-orm';
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
      enrolledAt: r.enrolledAt,
      lastSeen: r.lastSeen,
    }));
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
    await db
      .update(devices)
      .set(set)
      .where(eq(devices.deviceToken, args.deviceToken));
  }

  async reportPushError(args: { deviceToken: string; error: string }): Promise<void> {
    const db = getDb();
    await db
      .update(devices)
      .set({ lastPushError: args.error })
      .where(eq(devices.deviceToken, args.deviceToken));
  }
}
