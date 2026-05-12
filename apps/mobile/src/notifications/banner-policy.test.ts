import { describe, expect, it } from 'vitest';
import { conversationIdForDirect, conversationIdForGroup } from '@speakeasy/shared';
import { decideBanner, type BannerPolicyInputs } from './banner-policy.js';
import type { ActiveCall } from '../calls/types.js';

const ME = 'bento';
const PEER = 'amber';
// 26-char Crockford-base32 ULID body, prefixed `grp-` per shared
// GROUP_ID_REGEX.
const GROUP = 'grp-01ARZ3NDEKTSV4RRFFQ69G5FAV';

const baseInputs = (
  overrides: Partial<BannerPolicyInputs> = {},
): BannerPolicyInputs => ({
  myUserId: ME,
  inboundFrom: PEER,
  inboundText: 'hello',
  inboundTarget: { kind: 'direct', peerId: PEER },
  inAppNotificationsEnabled: true,
  activeConversationId: undefined,
  isMuted: () => false,
  activeCall: undefined,
  ...overrides,
});

const ringingCall: ActiveCall = {
  callId: 'c1',
  peerUserId: PEER,
  isCaller: false,
  stage: 'incoming_ringing',
  stageEnteredAt: 1,
  micMuted: false,
  speakerOn: false,
  kind: 'audio',
};

const endedCall: ActiveCall = {
  ...ringingCall,
  stage: 'ended',
  endedReason: 'completed',
};

describe('decideBanner', () => {
  it('shows the banner in the happy path', () => {
    const d = decideBanner(baseInputs(), 'msg-1');
    expect(d.kind).toBe('show');
    if (d.kind === 'show') {
      expect(d.banner.id).toBe('msg-1');
      expect(d.banner.sender).toBe(PEER);
      expect(d.banner.text).toBe('hello');
      expect(d.banner.target).toEqual({ kind: 'direct', peerId: PEER });
    }
  });

  it('suppresses when the global toggle is off', () => {
    const d = decideBanner(
      baseInputs({ inAppNotificationsEnabled: false }),
      'm',
    );
    expect(d.kind).toBe('disabled');
  });

  it('suppresses when the user is on the target conversation (direct)', () => {
    const cid = conversationIdForDirect(ME, PEER);
    const d = decideBanner(
      baseInputs({ activeConversationId: cid }),
      'm',
    );
    expect(d.kind).toBe('active-conv');
  });

  it('suppresses when the user is on the target group', () => {
    const cid = conversationIdForGroup(GROUP);
    const d = decideBanner(
      baseInputs({
        inboundTarget: { kind: 'group', groupId: GROUP },
        activeConversationId: cid,
      }),
      'm',
    );
    expect(d.kind).toBe('active-conv');
  });

  it('does NOT suppress when the user is on a different conversation', () => {
    const otherCid = conversationIdForDirect(ME, 'kim');
    const d = decideBanner(
      baseInputs({ activeConversationId: otherCid }),
      'm',
    );
    expect(d.kind).toBe('show');
  });

  it('suppresses when the target conversation is muted', () => {
    const cid = conversationIdForDirect(ME, PEER);
    const d = decideBanner(
      baseInputs({ isMuted: (id: string) => id === cid }),
      'm',
    );
    expect(d.kind).toBe('muted');
  });

  it('does NOT suppress when a different conversation is muted', () => {
    const otherCid = conversationIdForDirect(ME, 'kim');
    const d = decideBanner(
      baseInputs({ isMuted: (id: string) => id === otherCid }),
      'm',
    );
    expect(d.kind).toBe('show');
  });

  it('suppresses when an active call is in flight', () => {
    const d = decideBanner(
      baseInputs({ activeCall: ringingCall }),
      'm',
    );
    expect(d.kind).toBe('in-call');
  });

  it('does NOT suppress when the active-call slot is in `ended` stage', () => {
    // Orchestrator clears `active` to undefined eventually but keeps
    // it briefly in `ended` — we shouldn't treat that as "in-call".
    const d = decideBanner(
      baseInputs({ activeCall: endedCall }),
      'm',
    );
    expect(d.kind).toBe('show');
  });

  it('mute takes precedence over the in-call gate (order-stable)', () => {
    // Both branches active — ensure the documented ordering wins.
    // Mute fires first per the function's body, so the decision is
    // `muted`. Asserting this prevents an accidental reordering
    // from silently changing user-visible behavior (e.g. a muted
    // conversation showing a banner during a call).
    const cid = conversationIdForDirect(ME, PEER);
    const d = decideBanner(
      baseInputs({
        isMuted: (id: string) => id === cid,
        activeCall: ringingCall,
      }),
      'm',
    );
    expect(d.kind).toBe('muted');
  });
});
