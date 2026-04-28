/** Spec §11 Phase 4 multi-device. Recorded mappings of user → device tokens. */

export interface DeviceRecord {
  deviceToken: string;
  userId: string;
  pushToken?: string;
  platform?: 'ios' | 'android';
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
}
