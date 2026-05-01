import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  publicKey: bytea('public_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export const communities = pgTable('communities', {
  id: text('id').primaryKey(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  ttlDays: integer('ttl_days').notNull().default(7),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('devices_user_idx').on(t.userId),
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
    delivered: boolean('delivered').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    conversationIdx: index('messages_conversation_idx').on(t.conversation, t.createdAt),
    expiresIdx: index('messages_expires_idx').on(t.expiresAt),
    recipientIdx: index('messages_recipient_idx').on(t.recipientId),
  }),
);
