import { describe, expect, it, vi } from 'vitest';
import type { WsServerMsg } from '@speakeasy/shared';
import { makeMessageRouter, type MessageRouterDeps } from './message-router.js';

/**
 * Minimal deps stub. The router accepts a lot of dependencies for the
 * heavy frames (`message`, `group_msg`, `prekeys_low`, etc.) but the
 * control frames we exercise here — `authed`, `pong`, `error` — only
 * read `log` and the optional `onAuthed` hook.
 */
function makeStubDeps(over: Partial<MessageRouterDeps> = {}): MessageRouterDeps {
  return {
    myUserId: 'me',
    api: {} as MessageRouterDeps['api'],
    signalProtocol: {} as MessageRouterDeps['signalProtocol'],
    groupMessaging: {} as MessageRouterDeps['groupMessaging'],
    ws: {} as MessageRouterDeps['ws'],
    orchestrator: {} as MessageRouterDeps['orchestrator'],
    onPrekeysLow: vi.fn(),
    addToConversation: vi.fn(),
    markDelivered: vi.fn(),
    markMessageRead: vi.fn(),
    markReadUpTo: vi.fn(),
    ensureGroupHydrated: vi.fn(async () => undefined),
    conversationIdFor: vi.fn(() => 'conv-stub'),
    log: vi.fn(),
    ...over,
  };
}

describe('messageRouter — authed frame', () => {
  it('fires onAuthed when the server sends an authed frame', () => {
    const onAuthed = vi.fn();
    const router = makeMessageRouter(makeStubDeps({ onAuthed }));

    router({ type: 'authed', user_id: 'me' } as WsServerMsg);

    expect(onAuthed).toHaveBeenCalledTimes(1);
  });

  it('does not crash when onAuthed is not provided (back-compat)', () => {
    const router = makeMessageRouter(makeStubDeps());
    expect(() => router({ type: 'authed', user_id: 'me' } as WsServerMsg)).not.toThrow();
  });

  it('fires onAuthed once per authed frame across reconnects', () => {
    const onAuthed = vi.fn();
    const router = makeMessageRouter(makeStubDeps({ onAuthed }));

    // Simulate three handshakes (cold start → background → reconnect → background → reconnect)
    router({ type: 'authed', user_id: 'me' } as WsServerMsg);
    router({ type: 'authed', user_id: 'me' } as WsServerMsg);
    router({ type: 'authed', user_id: 'me' } as WsServerMsg);

    expect(onAuthed).toHaveBeenCalledTimes(3);
  });

  it('does not fire onAuthed for non-authed frames', () => {
    const onAuthed = vi.fn();
    const router = makeMessageRouter(makeStubDeps({ onAuthed }));

    router({ type: 'pong' } as WsServerMsg);
    router({ type: 'error', code: 'oops', message: 'no' } as WsServerMsg);
    router({ type: 'delivered', message_id: 'm1' } as WsServerMsg);

    expect(onAuthed).not.toHaveBeenCalled();
  });
});

describe('messageRouter — peer_deleted frame', () => {
  it('forwards the handle to onPeerDeleted', () => {
    const onPeerDeleted = vi.fn();
    const router = makeMessageRouter(makeStubDeps({ onPeerDeleted }));

    router({ type: 'peer_deleted', handle: 'quiet_fox' } as WsServerMsg);

    expect(onPeerDeleted).toHaveBeenCalledTimes(1);
    expect(onPeerDeleted).toHaveBeenCalledWith('quiet_fox');
  });

  it('does not crash when onPeerDeleted is not wired (back-compat)', () => {
    const router = makeMessageRouter(makeStubDeps());
    expect(() =>
      router({ type: 'peer_deleted', handle: 'quiet_fox' } as WsServerMsg),
    ).not.toThrow();
  });
});
