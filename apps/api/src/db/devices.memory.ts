import type { DeviceRecord, DevicesRepo } from './devices.js';

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

  async setPushToken(args: { deviceToken: string; pushToken: string; platform: 'ios' | 'android' }): Promise<void> {
    const device = this.devices.get(args.deviceToken);
    if (device) {
      device.pushToken = args.pushToken;
      device.platform = args.platform;
    }
    // If device doesn't exist yet, silently ignore — the device must
    // have been seen via upsertOnSeen first (auth handshake).
  }
}
