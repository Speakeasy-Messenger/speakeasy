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

  it('orders messages by sentAt (chronological), regardless of arrival order', () => {
    // A message buffered server-side while the recipient was offline can
    // arrive AFTER newer live messages — the app tears the WS down on every
    // background, so backlog delivery is fragmented across reconnects and
    // arrives out of send order. It must still sort to its sent-time
    // position, not land out of order at the bottom (reported 2026-06-14:
    // 2:33–2:37pm messages interleaved wrong).
    useConversations.getState().add(CONV, { ...baseMsg('first'), sentAt: 1_000 });
    useConversations.getState().add(CONV, { ...baseMsg('second'), sentAt: 3_000 });
    // "buffered" arrives last in call order but was SENT first → top.
    useConversations.getState().add(CONV, { ...baseMsg('buffered'), sentAt: 500 });
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual([
      'buffered',
      'first',
      'second',
    ]);
  });

  it('ignores receivedAt for ordering — sentAt wins', () => {
    // receivedAt may still be recorded, but it no longer drives order. A
    // late backlog batch (high receivedAt, low sentAt) sorts by send time.
    useConversations.getState().add(CONV, { ...baseMsg('sent-2'), sentAt: 2_000, receivedAt: 9_000 });
    useConversations.getState().add(CONV, { ...baseMsg('sent-1'), sentAt: 1_000, receivedAt: 9_500 });
    useConversations.getState().add(CONV, { ...baseMsg('sent-3'), sentAt: 3_000, receivedAt: 8_000 });
    expect(useConversations.getState().byId[CONV]?.messages.map((m) => m.id)).toEqual([
      'sent-1',
      'sent-2',
      'sent-3',
    ]);
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
    // Unread is now counted by ARRIVAL time (receivedAt), not sentAt — set
    // receivedAt explicitly so the test is deterministic rather than relying
    // on the add()-time Date.now() colliding with lastReadAt in the same ms.
    const now = Date.now();
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('m1'), sentAt: now - 2000, receivedAt: now - 2000 });
    useConversations.getState().markRead(CONV); // lastReadAt ≈ now
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('m2'), sentAt: now + 1000, receivedAt: now + 1000 });
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('m3'), sentAt: now + 2000, receivedAt: now + 2000 });
    expect(useConversations.getState().unreadCountFor(CONV)).toBe(2);
  });

  it('counts a late-buffered message (old sentAt, late receivedAt) as unread', () => {
    // The exact bug: the server buffers a message while the recipient is
    // offline and relays it with its original (old) sentAt. It was SENT
    // before the user last read, but DELIVERED after. Counting by sentAt
    // would silently drop it from the unread badge (returns 0); counting by
    // receivedAt correctly marks it unread.
    const now = Date.now();
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('read-1'), sentAt: now - 5000, receivedAt: now - 5000 });
    useConversations.getState().markRead(CONV); // lastReadAt ≈ now
    useConversations
      .getState()
      .add(CONV, { ...baseMsg('buffered'), sentAt: now - 4000, receivedAt: now + 1000 });
    expect(useConversations.getState().unreadCountFor(CONV)).toBe(1);
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
