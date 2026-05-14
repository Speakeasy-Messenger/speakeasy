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
  }): Promise<void> {
    // rc.80: rotate the FCM token off any OTHER device row that
    // currently holds it. FCM tokens are device-installation-
    // scoped — if the same physical device reinstalls and onboards
    // as a different userId, both rows would otherwise share the
    // token, and pushes for the old userId would surface on the
    // new userId's lockscreen. See devices.drizzle.ts for the
    // full repro narrative.
    for (const [otherToken, otherDevice] of this.devices) {
      if (
        otherToken !== args.deviceToken &&
        otherDevice.pushToken === args.pushToken
      ) {
        otherDevice.pushToken = undefined;
      }
    }
    const device = this.devices.get(args.deviceToken);
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
    // If device doesn't exist yet, silently ignore — the device must
    // have been seen via upsertOnSeen first (auth handshake).
  }

  async reportPushError(args: { deviceToken: string; error: string }): Promise<void> {
    const device = this.devices.get(args.deviceToken);
    if (device) {
      device.lastPushError = args.error;
    }
  }
}
