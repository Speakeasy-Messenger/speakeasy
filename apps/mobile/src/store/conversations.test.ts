import { beforeEach, describe, expect, it } from 'vitest';
import { TTL_OPTIONS } from '@speakeasy/shared';
import { useConversations, type ChatMessage } from './conversations.js';

beforeEach(() => useConversations.getState().reset());

const baseMsg = (id: string): ChatMessage => ({
  id,
  from: 'silent-golden-hawk',
  text: 'hi',
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
});
