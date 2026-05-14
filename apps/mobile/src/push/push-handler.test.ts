import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resolveTarget, registerForegroundMessageHandler, registerNotificationOpenedListener, type FcmData } from './push-handler.js';
import { useConversations } from '../store/conversations.js';
import { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';

describe.skip('resolveTarget', () => {
  beforeEach(() => {
    __resetAsyncStorageMock();
    // Reset conversation store so each test starts clean
    useConversations.setState({ byId: {}, hydrated: true });
  });

  it('resolves a direct message push to a direct tap-target', () => {
    useConversations.setState({
      byId: {
        'dm-abc123': {
          kind: 'direct',
          peerUserId: 'bananaman4',
          createdAt: Date.now(),
          messages: [],
          ttl: 'week',
          persistenceEnabled: false,
        },
      },
      hydrated: true,
    });

    const data: FcmData = {
      conversation_id: 'dm-abc123',
      msg_type: 'direct',
      notify_kind: 'message',
    };

    const target = resolveTarget(data);
    expect(target).toEqual({ kind: 'direct', peerId: 'bananaman4' });
  });

  it('resolves a group message push to a group tap-target', () => {
    const data: FcmData = {
      conversation_id: 'grp-xyz789',
      msg_type: 'group',
      notify_kind: 'message',
    };

    const target = resolveTarget(data);
    expect(target).toEqual({ kind: 'group', groupId: 'grp-xyz789' });
  });

  it('resolves a call push with a known conversation', () => {
    useConversations.setState({
      byId: {
        'dm-callpeer': {
          kind: 'direct',
          peerUserId: 'lunchbox8',
          createdAt: Date.now(),
          messages: [],
          ttl: 'week',
          persistenceEnabled: false,
        },
      },
      hydrated: true,
    });

    const data: FcmData = {
      conversation_id: 'dm-callpeer',
      msg_type: 'direct',
      notify_kind: 'call',
    };

    const target = resolveTarget(data);
    expect(target).toEqual({ kind: 'call', peerId: 'lunchbox8' });
  });

  it('resolves a call push without a known conversation (cold-start race)', () => {
    const data: FcmData = {
      conversation_id: 'dm-unknownpeer',
      msg_type: 'direct',
      notify_kind: 'call',
    };

    const target = resolveTarget(data);
    // Falls back to using the conversation_id as peerId
    expect(target).toEqual({ kind: 'call', peerId: 'dm-unknownpeer' });
  });

  it('returns undefined for missing conversation_id on message pushes', () => {
    const data: FcmData = {
      notify_kind: 'message',
    };

    const target = resolveTarget(data);
    expect(target).toBeUndefined();
  });

  it('returns undefined for empty data', () => {
    const target = resolveTarget({});
    expect(target).toBeUndefined();
  });

  it('falls back to conversation_id as peerId for unknown direct conversations', () => {
    const data: FcmData = {
      conversation_id: 'dm-notyetloaded',
      msg_type: 'direct',
      notify_kind: 'message',
    };

    const target = resolveTarget(data);
    // Navigation hook will re-resolve after hydration catches up
    expect(target).toEqual({ kind: 'direct', peerId: 'dm-notyetloaded' });
  });

  it('defaults notify_kind to "message" when missing', () => {
    const data: FcmData = {
      conversation_id: 'grp-default',
      msg_type: 'group',
    };

    const target = resolveTarget(data);
    expect(target).toEqual({ kind: 'group', groupId: 'grp-default' });
  });

  it('defaults msg_type to "direct" when missing', () => {
    useConversations.setState({
      byId: {
        'dm-implicit': {
          kind: 'direct',
          peerUserId: 'asiangamble3',
          createdAt: Date.now(),
          messages: [],
          ttl: 'week',
          persistenceEnabled: false,
        },
      },
      hydrated: true,
    });

    const data: FcmData = {
      conversation_id: 'dm-implicit',
      notify_kind: 'message',
    };

    const target = resolveTarget(data);
    expect(target).toEqual({ kind: 'direct', peerId: 'asiangamble3' });
  });
});

describe('registerForegroundMessageHandler', () => {
  it('is idempotent — calling twice does not throw', () => {
    // First call registers the handler (may already be registered if
    // other tests ran first; that's fine — idempotent).
    registerForegroundMessageHandler();
    expect(() => registerForegroundMessageHandler()).not.toThrow();
  });

  it('does not require React context — can be called at module level', () => {
    // This is the key property that prevents the "2x push" bug:
    // the handler must be registerable outside any useEffect/hook,
    // before React even mounts. If this throws, the module-level
    // registration in App.tsx would crash at import time.
    expect(() => registerForegroundMessageHandler()).not.toThrow();
  });
});

describe('registerNotificationOpenedListener', () => {
  it('is idempotent — calling twice does not throw', () => {
    registerNotificationOpenedListener();
    expect(() => registerNotificationOpenedListener()).not.toThrow();
  });

  it('does not require React context — can be called at module level', () => {
    // The warm-resume bug: onNotificationOpenedApp fires before
    // React useEffect re-runs, so the listener MUST be registerable
    // at module level outside any hook.
    expect(() => registerNotificationOpenedListener()).not.toThrow();
  });
});
