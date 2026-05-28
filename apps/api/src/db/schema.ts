import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    publicKey: bytea('public_key').notNull(),
    /**
     * Vouchflow deviceToken from /enroll. Used to resolve
     * authenticated requests back to the Speakeasy userId, since
     * real Vouchflow doesn't track our internal id.
     */
    deviceToken: text('device_token').notNull(),
    /**
     * Animal id picked in the avatar picker (Phase 2 brand overhaul,
     * AVATAR-SYSTEM.md §8). One of the 12 launch ids: fox / owl /
     * raven / hare / stag / whale / moth / octopus / heron / bear /
     * cat / bat. Nullable for users enrolled before Phase 2 OR users
     * who haven't reached onboarding's "Choose your face" screen —
     * mobile clients fall back to a deterministic-from-userId default.
     *
     * Replaces the old `avatar_b64` JPEG column. Server doesn't store
     * photos at all anymore; the column was dropped via migration
     * 0009_animal_avatars.sql.
     */
    selectedAvatarId: text('selected_avatar_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deviceTokenIdx: index('users_device_token_idx').on(t.deviceToken),
  }),
);

export const prekeyBundles = pgTable('prekey_bundles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  registrationId: integer('registration_id').notNull(),
  signedPrekeyId: integer('signed_prekey_id').notNull(),
  signedPrekey: bytea('signed_prekey').notNull(),
  signedPrekeySig: bytea('signed_prekey_sig').notNull(),
  prekeys: jsonb('prekeys').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  // Display name set by the creator at /v1/groups POST time. Nullable
  // because existing pre-migration-0014 rows have no name, and the
  // mobile client falls back to a "Room with @x, @y" default for
  // unnamed groups. Per spec the name is plaintext server-side — we
  // need it to propagate to invitees on add (creator-only knowledge
  // would defeat the goal of new members seeing the room's identity
  // when a group message lands).
  name: text('name'),
  // Per AVATAR-SYSTEM.md §7, groups don't have photos OR custom marks
  // — the room-mark glyph is deterministic from `id`. Customization
  // here would create exactly the social-signaling pressure ("our
  // group has the cool icon") the no-identity ethos rejects. The
  // `avatar_b64` column was dropped in migration 0009.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index('group_members_user_idx').on(t.userId),
  }),
);

export const communities = pgTable(
  'communities',
  {
    id: text('id').primaryKey(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    ttlDays: integer('ttl_days').notNull().default(7),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Mirrors `communities_ttl_days_check` in 0001_initial.sql.
    ttlDaysPositive: check('communities_ttl_days_check', sql`${t.ttlDays} > 0`),
  }),
);

/**
 * Channel-key envelopes — spec §4b. Channel key K is wrapped once per
 * recipient (with that recipient's identity public key) and stored here.
 * Server holds envelopes only; never plaintext K.
 */
export const communityKeyEnvelopes = pgTable(
  'community_key_envelopes',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'cascade' }),
    recipientUserId: text('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wrappedKey: bytea('wrapped_key').notNull(),
    wrappedByUserId: text('wrapped_by_user_id')
      .notNull()
      .references(() => users.id),
    keyEpoch: integer('key_epoch').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.communityId, t.recipientUserId, t.keyEpoch] }),
    recipientIdx: index('community_key_envelopes_recipient_idx').on(t.recipientUserId),
  }),
);

export const communityMembers = pgTable(
  'community_members',
  {
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.communityId, t.userId] }),
    userIdx: index('community_members_user_idx').on(t.userId),
    // Mirrors `community_members_role_check` in 0001_initial.sql.
    roleEnum: check(
      'community_members_role_check',
      sql`${t.role} IN ('member', 'moderator')`,
    ),
  }),
);

/**
 * Phase 4: multi-device. One Speakeasy user can have N device_tokens.
 * Server records pairings observed at enrollment / WS-auth time.
 */
export const devices = pgTable(
  'devices',
  {
    deviceToken: text('device_token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pushToken: text('push_token'),
    platform: text('platform'),
    // 'rich' or 'private'. Drives FCM/APNs system-banner copy. NULL is
    // interpreted as 'rich' at read-time so pre-Phase-5d-knob rows
    // don't all silently get the privacy mode they didn't ask for.
    notificationPrivacy: text('notification_privacy'),
    /** Last reason getToken() or push-token registration failed. NULL when token is registered. */
    lastPushError: text('last_push_error'),
    /**
     * Per-device list of call kinds this device can answer (migration
     * 0018). Server's call-router reads the LIVE in-memory version via
     * `connections.getCapabilitiesUnion` for fan-out filtering; the
     * persisted column is the fallback for cold-cache `GET /v1/users/:id`
     * responses. NOT NULL; defaults to `['audio','video']` (the pre-rc.130
     * historical capability set).
     */
    supportedCallKinds: text('supported_call_kinds')
      .array()
      .notNull()
      .default(sql`ARRAY['audio', 'video']`),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('devices_user_idx').on(t.userId),
    // Mirrors `devices_platform_check` in 0003_devices.sql.
    platformEnum: check(
      'devices_platform_check',
      sql`${t.platform} IS NULL OR ${t.platform} IN ('ios', 'android')`,
    ),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversation: text('conversation').notNull(),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id),
    recipientId: text('recipient_id').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    msgType: text('msg_type').notNull(),
    skdmGroupId: text('skdm_group_id'),
    targetDevices: jsonb('target_devices').notNull().$type<string[]>().default([]),
    deliveredToDevices: jsonb('delivered_to_devices').notNull().$type<string[]>().default([]),
    sealed: boolean('sealed').notNull().default(false),
    delivered: boolean('delivered').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    conversationIdx: index('messages_conversation_idx').on(t.conversation, t.createdAt),
    // Partial index — only indexes undelivered rows. Per
    // 0001_initial.sql; the prod DB already has the partial form.
    // `index().where()` is the drizzle-orm primitive that captures it.
    expiresIdx: index('messages_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.delivered} = FALSE`),
    recipientIdx: index('messages_recipient_idx').on(t.recipientId),
    // Mirrors `messages_msg_type_check` in 0001_initial.sql.
    msgTypeEnum: check(
      'messages_msg_type_check',
      sql`${t.msgType} IN ('direct', 'group', 'community')`,
    ),
  }),
);

/**
 * User-submitted feedback for the dev team. The `@feedback` handle is
 * special-cased in the availability route (always taken) and on the
 * mobile send path (POST /v1/feedback instead of WS-encrypt-and-send).
 * Plaintext on purpose — opt-in by the user, not E2E.
 */
export const feedback = pgTable('feedback', {
  id: text('id').primaryKey(),
  senderUserId: text('sender_user_id').notNull(),
  appVersion: text('app_version'),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

/**
 * Per-(reporter, reported) abuse reports. UNIQUE on the pair so a single
 * user cannot drive the auto-ban threshold alone. Five distinct reporters
 * within `ABUSE_REPORT_DECAY_DAYS` triggers account deletion of the
 * reported user via the route's transactional ban path.
 *
 * `reported_user_id` deliberately has NO foreign key: once the auto-ban
 * deletes the reported user, the report rows survive as an audit trail.
 *
 * See `infra/migrations/0019_abuse_reports.sql` for the canonical
 * column comments + behavioral notes.
 */
export const abuseReports = pgTable(
  'abuse_reports',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reporterUserId: text('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportedUserId: text('reported_user_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reporterReportedUq: unique('abuse_reports_reporter_reported_key').on(
      t.reporterUserId,
      t.reportedUserId,
    ),
    reportedRecentIdx: index('abuse_reports_reported_recent_idx').on(
      t.reportedUserId,
      t.createdAt,
    ),
    reasonEnum: check(
      'abuse_reports_reason_check',
      sql`${t.reason} IN ('spam', 'harassment', 'threats', 'hate_speech', 'other')`,
    ),
    detailLen: check(
      'abuse_reports_detail_len_check',
      sql`${t.detail} IS NULL OR length(${t.detail}) <= 200`,
    ),
  }),
);

/**
 * Persistent server-side event log for diagnostics whose answers fly's
 * 5-minute stdout buffer can't reach. See migrations/0015.
 *
 * One row per `eventLog.record()` call. Wired from the push path first;
 * other paths can layer in by importing the repo. Not a general log
 * sink — only events that are explicitly persisted land here.
 */
export const serverEventLog = pgTable(
  'server_event_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull(),
    userId: text('user_id'),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => ({
    userTsIdx: index('server_event_log_user_ts').on(t.userId, t.ts),
    typeTsIdx: index('server_event_log_type_ts').on(t.eventType, t.ts),
  }),
);
