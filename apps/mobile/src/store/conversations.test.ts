import { beforeEach, describe, expect, it } from 'vitest';
import { TTL_OPTIONS } from '@speakeasy/shared';
import { useConversations, type ChatMessage } from './conversations.js';

beforeEach(() => useConversations.getState().reset());

const baseMsg = (id: string): ChatMessage => ({
  id,
  from: 'silent-golden-hawk',
  // Per-id text so the inbound content-dedup guard (same sender + same
  // text + same window) doesn't collapse distinct test messages into
  // one. Real-world inbounds always carry distinct payloads.
  text: `hi ${id}`,
  kind: 'direct',
  sentAt: 1_000,
  stage: 'sent',
});

const CONV = 'dm-0123456789abcdef';

describe('useConversations', () => {
  it('add appends to a new conversation', () => {
    const s = useConversations.getState();
    s.add(CONV, baseMsg('m1'));
    expect(s.byId[CONV]).toBeUndefined(); // local snapshot is stale
    expect(useConversations.getState().byId[CONV]?.messages).toHaveLength(1);
  });

  it('add appends to an existing conversation', () => {
    useConversations.getState().add(CONV, baseMsg('m1'));
    useConversations.getState().add(CONV, baseMsg('m2'));
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('add keeps messages in arrival order regardless of sentAt skew', () => {
    // rc.19 fix (peachtree feedback): a message buffered by the server
    // while the recipient was offline arrives via WS with a sentAt
    // value from minutes earlier. The OLD behavior sorted by sentAt,
    // which buried the late-arriving message above messages the user
    // had already been reading — so tapping its push notification
    // landed the user in the chat with the message they tapped on
    // four messages back in history, looking "vanished."
    //
    // The fix: stamp receivedAt = Date.now() on every add(), and sort
    // by receivedAt. Messages stay in CALL order regardless of sentAt
    // skew, so a late-relayed message lands at the BOTTOM of the chat
    // where the user expects it.
    useConversations.getState().add(CONV, { ...baseMsg('first'), sentAt: 1_000 });
    useConversations.getState().add(CONV, { ...baseMsg('second'), sentAt: 3_000 });
    // "buffered" arrives third in call order, but with the OLDEST sentAt
    useConversations.getState().add(CONV, { ...baseMsg('buffered'), sentAt: 500 });
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual([
      'first',
      'second',
      'buffered',
    ]);
  });

  it('add honors an explicit receivedAt when the caller supplies one', () => {
    // Messages restored from persistence carry their original
    // receivedAt — sort must use the supplied value, not Date.now().
    // Otherwise rehydration scrambles the chat history.
    useConversations.getState().add(CONV, {
      ...baseMsg('newest'),
      sentAt: 1_000,
      receivedAt: 3_000,
    });
    useConversations.getState().add(CONV, {
      ...baseMsg('oldest'),
      sentAt: 1_000,
      receivedAt: 1_000,
    });
    useConversations.getState().add(CONV, {
      ...baseMsg('middle'),
      sentAt: 1_000,
      receivedAt: 2_000,
    });
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('add falls back to sentAt for messages without receivedAt (legacy persisted state)', () => {
    // Pre-rc.19 persisted messages don't have receivedAt. They should
    // still sort cleanly — the fallback keys off sentAt, the same way
    // the legacy code did. Mixing legacy + new in the same chat should
    // interleave correctly.
    const stamped = { ...baseMsg('stamped'), receivedAt: 2_500 };
    const legacyEarly = { ...baseMsg('legacy-early'), sentAt: 1_000 };
    const legacyLate = { ...baseMsg('legacy-late'), sentAt: 4_000 };
    useConversations.getState().add(CONV, stamped);
    useConversations.getState().add(CONV, legacyEarly);
    useConversations.getState().add(CONV, legacyLate);
    // Note: legacyEarly + legacyLate get implicit receivedAt = Date.now()
    // here because the add() function stamps when receivedAt is missing.
    // The test verifies that the EXPLICIT receivedAt on `stamped` still
    // participates in the same sort. Insertion order: stamped (2500),
    // legacy-early (~now), legacy-late (~now). All three implicit times
    // will be > 2500, so `stamped` lands first.
    expect(useConversations.getState().byId[CONV]?.messages[0]?.id).toBe('stamped');
  });

  it('add dedupes inbound content duplicates (different ids, same text within 2s)', () => {
    // The sender's client retries on a flaky upload and ends up with two
    // distinct ULIDs for what the user typed once. Both reach the server,
    // both get delivered. Without this guard the chat shows the same
    // bubble twice. Reproduced from a real diag log on 2026-05-23 —
    // bananaman2 sent "Idk i think its just his husband" and rc.124's
    // client rendered it twice.
    useConversations.getState().add(CONV, {
      ...baseMsg('m1'),
      text: 'Idk i think its just his husband',
      sentAt: 1_000_000,
    });
    useConversations.getState().add(CONV, {
      ...baseMsg('m2'),
      text: 'Idk i think its just his husband',
      sentAt: 1_000_001,
    });
    expect(useConversations.getState().byId[CONV]?.messages).toHaveLength(1);
    expect(useConversations.getState().byId[CONV]?.messages[0]!.id).toBe('m1');
  });

  it('add does not dedupe inbound content when sentAt is outside the 2s window', () => {
    // Two genuine identical messages from the same sender, spaced apart
    // — they're not duplicates. Keep both.
    useConversations.getState().add(CONV, {
      ...baseMsg('m1'),
      text: 'lol',
      sentAt: 1_000_000,
    });
    useConversations.getState().add(CONV, {
      ...baseMsg('m2'),
      text: 'lol',
      sentAt: 1_005_000,
    });
    expect(useConversations.getState().byId[CONV]?.messages).toHaveLength(2);
  });

  it('add does not dedupe outbound own messages (from === "me")', () => {
    // The optimistic-echo path uses `from: "me"`, and a user retapping
    // send on the same text deliberately is still two messages.
    useConversations.getState().add(CONV, {
      ...baseMsg('m1'),
      from: 'me',
      text: 'sending twice on purpose',
      sentAt: 1_000_000,
    });
    useConversations.getState().add(CONV, {
      ...baseMsg('m2'),
      from: 'me',
      text: 'sending twice on purpose',
      sentAt: 1_000_500,
    });
    expect(useConversations.getState().byId[CONV]?.messages).toHaveLength(2);
  });

  it('add dedupes by message id (server redelivery should not duplicate)', () => {
    // Server may redeliver a message whose ack was lost in a WS flap.
    // Without dedupe, each redelivery decrypts against an already-
    // advanced ratchet, fails, and pushes a fresh "[decrypt failed]"
    // bubble — the alpha-0.4.4 reproducer that motivated this guard.
    useConversations.getState().add(CONV, baseMsg('m1'));
    useConversations.getState().add(CONV, { ...baseMsg('m1'), text: 'redelivery' });
    useConversations.getState().add(CONV, { ...baseMsg('m1'), text: 'another redelivery' });
    const msgs = useConversations.getState().byId[CONV]!.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('hi m1');
  });

  it('setStage updates a single message', () => {
    useConversations.getState().add(CONV, baseMsg('m1'));
    useConversations.getState().add(CONV, baseMsg('m2'));
    useConversations.getState().setStage(CONV, 'm2', 'disappearing');
    const msgs = useConversations.getState().byId[CONV]!.messages;
    expect(msgs.find((m) => m.id === 'm1')?.stage).toBe('sent');
    expect(msgs.find((m) => m.id === 'm2')?.stage).toBe('disappearing');
  });

  it('remove drops by id', () => {
    useConversations.getState().add(CONV, baseMsg('m1'));
    useConversations.getState().add(CONV, baseMsg('m2'));
    useConversations.getState().remove(CONV, 'm1');
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('default TTL is `week`', () => {
    useConversations.getState().add(CONV, baseMsg('m1'));
    expect(useConversations.getState().byId[CONV]?.ttl).toBe('week');
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBe(TTL_OPTIONS.week);
  });

  it('per-conversation TTL override (spec §5)', () => {
    useConversations.getState().setTtl(CONV, 'day');
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBe(TTL_OPTIONS.day);
    useConversations.getState().setTtl(CONV, 'hour');
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBe(TTL_OPTIONS.hour);
    useConversations.getState().setTtl(CONV, 'off');
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBeNull();
  });

  it('persistence opt-in disables local TTL (spec §5)', () => {
    useConversations.getState().setTtl(CONV, 'hour');
    useConversations.getState().setPersistence(CONV, true);
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBeNull();
    useConversations.getState().setPersistence(CONV, false);
    expect(useConversations.getState().ttlSecondsFor(CONV)).toBe(TTL_OPTIONS.hour);
  });

  it('ttlSecondsFor unknown conversation returns the default', () => {
    expect(useConversations.getState().ttlSecondsFor('dm-unknownunknown')).toBe(
      TTL_OPTIONS.week,
    );
  });

  it('openDirect creates a direct conversation entry with peerUserId', () => {
    const id = useConversations
      .getState()
      .openDirect('alice-blue-fox', 'silent-golden-hawk');
    expect(id).toMatch(/^dm-[0-9a-f]{16}$/);
    const c = useConversations.getState().byId[id]!;
    expect(c.kind).toBe('direct');
    expect(c.peerUserId).toBe('silent-golden-hawk');
    expect(c.messages).toEqual([]);
  });

  it('openDirect is idempotent — preserves messages + ttl on re-open', () => {
    const id = useConversations
      .getState()
      .openDirect('alice-blue-fox', 'silent-golden-hawk');
    useConversations.getState().add(id, baseMsg('m1'));
    useConversations.getState().setTtl(id, 'hour');

    // Re-open: must NOT clobber messages or settings.
    const id2 = useConversations
      .getState()
      .openDirect('alice-blue-fox', 'silent-golden-hawk');
    expect(id2).toBe(id);
    const c = useConversations.getState().byId[id]!;
    expect(c.messages).toHaveLength(1);
    expect(c.ttl).toBe('hour');
    expect(c.peerUserId).toBe('silent-golden-hawk');
  });

  it('openDirect normalises sender/peer ordering — same id either direction', () => {
    const a = useConversations
      .getState()
      .openDirect('alice-blue-fox', 'silent-golden-hawk');
    useConversations.getState().reset();
    const b = useConversations
      .getState()
      .openDirect('silent-golden-hawk', 'alice-blue-fox');
    expect(a).toBe(b);
  });

  it('openGroup creates a group conversation entry', () => {
    const groupId = 'grp-0123456789abcdef';
    useConversations.getState().openGroup(groupId);
    const c = useConversations.getState().byId[groupId]!;
    expect(c.kind).toBe('group');
    expect(c.peerUserId).toBeUndefined();
    expect(c.messages).toEqual([]);
  });

  it('openGroup is idempotent — preserves messages + ttl on re-open', () => {
    const groupId = 'grp-0123456789abcdef';
    useConversations.getState().openGroup(groupId);
    useConversations.getState().add(groupId, { ...baseMsg('m1'), kind: 'group' });
    useConversations.getState().setTtl(groupId, 'hour');

    useConversations.getState().openGroup(groupId);
    const c = useConversations.getState().byId[groupId]!;
    expect(c.messages).toHaveLength(1);
    expect(c.ttl).toBe('hour');
  });

  it('openGroup unblocks markRead for a freshly-created group', () => {
    const groupId = 'grp-0123456789abcdef';
    // markRead alone is a no-op when the entry doesn't exist — it must
    // not silently swallow the read intent for a brand-new group.
    useConversations.getState().markRead(groupId);
    expect(useConversations.getState().byId[groupId]).toBeUndefined();

    useConversations.getState().openGroup(groupId);
    useConversations.getState().markRead(groupId);
    expect(useConversations.getState().byId[groupId]?.lastReadAt).toBeGreaterThan(0);
  });

  it('unreadCountFor returns 0 for unknown conversation', () => {
    expect(useConversations.getState().unreadCountFor('dm-unknown')).toBe(0);
  });

  it('unreadCountFor returns message count when nothing has been read', () => {
    useConversations.getState().add(CONV, baseMsg('m1'));
    useConversations.getState().add(CONV, { ...baseMsg('m2'), sentAt: 2_000 });
    expect(useConversations.getState().unreadCountFor(CONV)).toBe(2);
  });

  it('markRead sets lastReadAt; subsequent messages are unread', () => {
    const now = Date.now();
    useConversations.getState().add(CONV, { ...baseMsg('m1'), sentAt: now - 2000 });
    useConversations.getState().markRead(CONV);
    useConversations.getState().add(CONV, { ...baseMsg('m2'), sentAt: now + 1000 });
    useConversations.getState().add(CONV, { ...baseMsg('m3'), sentAt: now + 2000 });
    expect(useConversations.getState().unreadCountFor(CONV)).toBe(2);
  });

  it('markRead marks all existing messages as read', () => {
    const now = Date.now();
    useConversations.getState().add(CONV, { ...baseMsg('m1'), sentAt: now - 2000 });
    useConversations.getState().add(CONV, { ...baseMsg('m2'), sentAt: now - 1000 });
    useConversations.getState().markRead(CONV);
    expect(useConversations.getState().unreadCountFor(CONV)).toBe(0);
  });

  it('markDelivered flips a sent message to delivered=true regardless of conversation', () => {
    // The `delivered` WS frame only carries message_id, so the store
    // walks every conversation. Verify it finds + flips the right one
    // and leaves siblings alone.
    const sent: ChatMessage = { ...baseMsg('m-sent'), from: 'me', delivered: false };
    const other: ChatMessage = { ...baseMsg('m-other'), from: 'me', delivered: false };
    useConversations.getState().add(CONV, sent);
    useConversations.getState().add('dm-9999999999999999', other);

    useConversations.getState().markDelivered('m-sent');

    const flipped = useConversations
      .getState()
      .byId[CONV]!.messages.find((m) => m.id === 'm-sent');
    expect(flipped?.delivered).toBe(true);
    const untouched = useConversations
      .getState()
      .byId['dm-9999999999999999']!.messages.find((m) => m.id === 'm-other');
    expect(untouched?.delivered).toBe(false);
  });

  it('markDelivered for an unknown msgId is a no-op (no thrash, no spurious touch)', () => {
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('m1'), from: 'me', delivered: false });
    const before = useConversations.getState().byId;
    useConversations.getState().markDelivered('missing-id');
    expect(useConversations.getState().byId).toBe(before);
  });

  it('markDelivered is idempotent — re-firing the frame does not re-trigger persist', () => {
    // AckRouter cross-instance redelivery + multi-device acks can both
    // produce duplicate `delivered` frames. The bubble's flag is
    // monotone, so we should short-circuit on already-true.
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('m1'), from: 'me', delivered: false });
    useConversations.getState().markDelivered('m1');
    const afterFirst = useConversations.getState().byId;
    useConversations.getState().markDelivered('m1');
    expect(useConversations.getState().byId).toBe(afterFirst);
  });

  it('buffers a delivered receipt that arrived before its message and applies it on add', () => {
    // Inline replies sent from a notification banner are queued and drain
    // into the store on next foreground — the server's buffered
    // `delivered` ack can win that race. Without the in-memory holding
    // pen the receipt is dropped and the bubble is stuck on a single ✓.
    useConversations.getState().markDelivered('inline-1');
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('inline-1'), from: 'me', delivered: false });
    const m = useConversations
      .getState()
      .byId[CONV]!.messages.find((x) => x.id === 'inline-1');
    expect(m?.delivered).toBe(true);
  });

  it('buffers a read receipt that arrived before its message and applies it on add', () => {
    const ts = 1_700_000_000_000;
    useConversations.getState().markMessageRead('inline-2', ts);
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('inline-2'), from: 'me', delivered: false });
    const m = useConversations
      .getState()
      .byId[CONV]!.messages.find((x) => x.id === 'inline-2');
    expect(m?.readAt).toBe(ts);
    expect(m?.delivered).toBe(true);
  });
});
