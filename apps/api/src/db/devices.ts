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
  lastPushError?: string;
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
  /**
   * Distinct userIds owning at least one device whose `last_seen` is
   * within `maxAgeMs` of now. `last_seen` is touched (`upsertOnSeen`)
   * only after a WS handshake passed Vouchflow `validate()`, so "seen
   * recently" is the persisted proxy for "had a valid Vouchflow
   * session" — used by the @speaker broadcast to skip dead accounts
   * (Vouchflow itself stores no session; validity is checked live).
   */
  listActiveUserIds(maxAgeMs: number): Promise<string[]>;
  /** Detach a device — used for sign-out / loss-of-trust. */
  remove(deviceToken: string): Promise<'removed' | 'not_found'>;
  /** Store or update the push notification token for a device. The
   * privacy preference rides along on the same write so the mobile
   * client only needs one round-trip per startup. Omitting it leaves
   * the existing value alone (so toggling push off / on doesn't
   * silently reset the privacy choice).
   *
   * When `userId` is provided the implementation MUST guarantee that
   * after the call returns at least one device row owned by that user
   * holds `pushToken` — creating the row from (`deviceToken`,`userId`)
   * if needed. This closes the wipe-and-recover race observed for
   * tester15 on 2026-05-14: the HTTP `POST /v1/devices/push-token`
   * fires under a fresh Vouchflow `deviceToken` that the WS handshake
   * has not yet `upsertOnSeen`-ed, and the rotation clause would
   * otherwise null the OLD row's push_token while the UPDATE for the
   * NEW deviceToken matched zero rows — leaving `listForUser(userId)`
   * with zero devices holding a push token and every subsequent
   * `notifyDelivery` short-circuiting to `push.no_devices`.
   *
   * Omitting `userId` preserves legacy behavior (rotation + silent
   * no-op when the row is missing). Existing call sites that pair
   * `upsertOnSeen` immediately before `setPushToken` are unaffected.
   */
  setPushToken(args: {
    deviceToken: string;
    pushToken: string;
    platform: 'ios' | 'android';
    notificationPrivacy?: NotificationPrivacy;
    userId?: string;
  }): Promise<void>;

  /** Record why the last push-token registration failed (e.g. "android_post_notifications_denied", "native_module_missing"). Cleared on next successful setPushToken. */
  reportPushError(args: { deviceToken: string; error: string }): Promise<void>;

  /**
   * Null out the push_token column on any row currently holding the
   * given FCM/APNs token. Called by the push provider when FCM
   * returns `messaging/registration-token-not-registered` (UNREGISTERED)
   * or `messaging/invalid-registration-token`: the token is dead
   * server-side and continuing to send to it just wastes FCM quota
   * and pollutes the `push.attempted` aggregates with phantom
   * successes (FCM accepts dead tokens for a small window after
   * rotation). Recorded as the reason on `lastPushError` so the
   * next registration knows it was reaped, not user-revoked.
   */
  clearPushToken(args: { pushToken: string; reason: string }): Promise<void>;
}
