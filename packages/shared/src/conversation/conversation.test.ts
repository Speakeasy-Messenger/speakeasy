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

  it('rejects self-DM', () => {
    expect(() => conversationIdForDirect('one-two-three', 'one-two-three')).toThrow();
  });

  it('rejects malformed ids', () => {
    expect(() => conversationIdForDirect('not_valid', 'one-two-three')).toThrow();
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
