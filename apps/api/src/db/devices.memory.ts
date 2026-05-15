import type { DeviceRecord, DevicesRepo, NotificationPrivacy } from './devices.js';

export class InMemoryDevicesRepo implements DevicesRepo {
  readonly devices = new Map<string, DeviceRecord>();

  async upsertOnSeen(args: { deviceToken: string; userId: string }): Promise<void> {
    const existing = this.devices.get(args.deviceToken);
    if (existing) {
      existing.lastSeen = new Date();
      return;
    }
    this.devices.set(args.deviceToken, {
      deviceToken: args.deviceToken,
      userId: args.userId,
      enrolledAt: new Date(),
      lastSeen: new Date(),
    });
  }

  async listForUser(userId: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  async remove(deviceToken: string): Promise<'removed' | 'not_found'> {
    return this.devices.delete(deviceToken) ? 'removed' : 'not_found';
  }

  async setPushToken(args: {
    deviceToken: string;
    pushToken: string;
    platform: 'ios' | 'android';
    notificationPrivacy?: NotificationPrivacy;
    userId?: string;
  }): Promise<void> {
    // rc.92 ordering: write the target row FIRST, rotate AFTER.
    // Keeps the in-memory repo in lock-step with the Drizzle impl —
    // see devices.drizzle.ts:setPushToken for the full narrative of
    // the wipe-and-recover race this fixes.
    let device = this.devices.get(args.deviceToken);
    if (!device && args.userId !== undefined) {
      // Insert-on-conflict equivalent: create the row when the caller
      // supplies the userId. Closes the race where the HTTP
      // /v1/devices/push-token POST lands before the WS handshake
      // had a chance to upsertOnSeen the new Vouchflow deviceToken.
      device = {
        deviceToken: args.deviceToken,
        userId: args.userId,
        enrolledAt: new Date(),
        lastSeen: new Date(),
      };
      this.devices.set(args.deviceToken, device);
    }
    if (device) {
      device.pushToken = args.pushToken;
      device.platform = args.platform;
      device.lastPushError = undefined;
      // Only overwrite the privacy field when the caller actually
      // supplied one — see DevicesRepo.setPushToken contract.
      if (args.notificationPrivacy !== undefined) {
        device.notificationPrivacy = args.notificationPrivacy;
      }
    }
    // If device still doesn't exist (userId not provided AND no prior
    // upsertOnSeen), silently ignore — preserves legacy behavior for
    // tests + the WS handler that has always paired the two calls.

    // Rotation: clear the FCM token off any OTHER device row that
    // currently holds it. FCM tokens are device-installation-scoped;
    // see devices.drizzle.ts:setPushToken for the rc.80 metadata-
    // leak repro this addresses.
    for (const [otherToken, otherDevice] of this.devices) {
      if (
        otherToken !== args.deviceToken &&
        otherDevice.pushToken === args.pushToken
      ) {
        otherDevice.pushToken = undefined;
      }
    }
  }

  async reportPushError(args: { deviceToken: string; error: string }): Promise<void> {
    const device = this.devices.get(args.deviceToken);
    if (device) {
      device.lastPushError = args.error;
    }
  }

  async clearPushToken(args: { pushToken: string; reason: string }): Promise<void> {
    for (const device of this.devices.values()) {
      if (device.pushToken === args.pushToken) {
        device.pushToken = undefined;
        device.lastPushError = args.reason;
      }
    }
  }
}
