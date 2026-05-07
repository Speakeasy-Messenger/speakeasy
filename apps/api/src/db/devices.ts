/** Spec §11 Phase 4 multi-device. Recorded mappings of user → device tokens. */

/**
 * Per-device notification privacy preference. Drives what the FCM/APNs
 * payload reveals at the system-banner level (before the app gets a
 * chance to render its own notification).
 *
 *   `rich`    — banner shows the sender handle: "@bananaman1: New message"
 *   `private` — banner is generic: "speakeasy: New message"
 *
 * Defaults to `rich` when undefined (covers pre-Phase-5d-knob devices).
 * Sealed-sender messages always degrade to `private`-style copy
 * regardless of the recipient's preference — the server doesn't know
 * the sender for those.
 */
export type NotificationPrivacy = 'rich' | 'private';

export interface DeviceRecord {
  deviceToken: string;
  userId: string;
  pushToken?: string;
  platform?: 'ios' | 'android';
  notificationPrivacy?: NotificationPrivacy;
  enrolledAt: Date;
  lastSeen: Date;
}

export interface DevicesRepo {
  /**
   * Idempotent: insert (deviceToken, userId) if missing, otherwise touch
   * `last_seen`. The deviceToken is opaque from Vouchflow; the binding to
   * userId is established by Vouchflow's verify result.
   */
  upsertOnSeen(args: { deviceToken: string; userId: string }): Promise<void>;
  /** All devices currently associated with the user. */
  listForUser(userId: string): Promise<DeviceRecord[]>;
  /** Detach a device — used for sign-out / loss-of-trust. */
  remove(deviceToken: string): Promise<'removed' | 'not_found'>;
  /** Store or update the push notification token for a device. The
   * privacy preference rides along on the same write so the mobile
   * client only needs one round-trip per startup. Omitting it leaves
   * the existing value alone (so toggling push off / on doesn't
   * silently reset the privacy choice). */
  setPushToken(args: {
    deviceToken: string;
    pushToken: string;
    platform: 'ios' | 'android';
    notificationPrivacy?: NotificationPrivacy;
  }): Promise<void>;
}
