import { describe, expect, it } from 'vitest';
import {
  conversationIdForCommunity,
  conversationIdForDirect,
  conversationIdForGroup,
  isDirectConversationId,
} from './index.js';
import { newCommunityId, newGroupId } from '../ids/index.js';

describe('conversationIdForDirect', () => {
  it('is order-independent', () => {
    const a = conversationIdForDirect('alpha-bravo-charlie', 'delta-echo-foxtrot');
    const b = conversationIdForDirect('delta-echo-foxtrot', 'alpha-bravo-charlie');
    expect(a).toBe(b);
  });

  it('produces dm- prefixed 16-hex ids', () => {
    const id = conversationIdForDirect('alpha-bravo-charlie', 'delta-echo-foxtrot');
    expect(isDirectConversationId(id)).toBe(true);
  });

  it('different pairs produce different ids', () => {
    const a = conversationIdForDirect('one-two-three', 'four-five-six');
    const b = conversationIdForDirect('one-two-three', 'seven-eight-nine');
    expect(a).not.toBe(b);
  });

  it('allows self-DM (Notes to self)', () => {
    // Sender = recipient is a real use case (a "saved messages" thread
    // / a way to test the WS round-trip without a second device). The
    // sorted-pair sha256 collapses to sha256("self:self") which is
    // deterministic + unique to that user.
    const id = conversationIdForDirect('one-two-three', 'one-two-three');
    expect(id).toMatch(/^dm-[0-9a-f]{16}$/);
    // Idempotent on second call.
    expect(conversationIdForDirect('one-two-three', 'one-two-three')).toBe(id);
  });

  it('rejects malformed ids', () => {
    // Uppercase + `!` fails both the legacy 3-word and new handle formats.
    expect(() => conversationIdForDirect('AB!', 'one-two-three')).toThrow();
  });
});

describe('conversationIdForGroup / conversationIdForCommunity', () => {
  it('passes through valid group ids', () => {
    const g = newGroupId();
    expect(conversationIdForGroup(g)).toBe(g);
  });

  it('passes through valid community ids', () => {
    const c = newCommunityId();
    expect(conversationIdForCommunity(c)).toBe(c);
  });

  it('rejects mismatched id formats', () => {
    expect(() => conversationIdForGroup('com-xxx')).toThrow();
    expect(() => conversationIdForCommunity('grp-xxx')).toThrow();
  });
});

describe('isDirectConversationId', () => {
  it('matches dm-<16hex>', () => {
    expect(isDirectConversationId('dm-0123456789abcdef')).toBe(true);
    expect(isDirectConversationId('dm-bad')).toBe(false);
    expect(isDirectConversationId('grp-xyz')).toBe(false);
  });
});
