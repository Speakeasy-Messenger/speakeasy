import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodePayload,
  type Attachment,
  type WsServerMsg,
} from '@speakeasy/shared';
import { MockGroupMessagingClient, SignalClientError } from '@speakeasy/crypto';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { bytesToB64, utf8ToBytes } from '../utils/bytes.js';
import { clearSessionCache } from '../crypto/session.js';
import { __resetDiagForTests } from '../diag/log.js';
import { makeMessageRouter, type MessageRouterDeps } from './message-router.js';
import type { ChatMessage } from '../store/conversations.js';

/**
 * Inbound WS router coverage. We drive realistic frames through a
 * mocked signal/group-messaging stack and assert observable effects
 * (store writes via `addToConversation`, ack queueing via
 * `ws.enqueueAck`, the notify hook, etc.).
 *
 * Conventions copied from the sibling suites: vitest, `vi.fn` deps,
 * the `MockSignalProtocolClient` / `MockGroupMessagingClient` fakes
 * from `@speakeasy/crypto`. No react-test-renderer — the router is
 * framework-agnostic.
 */

const ME = 'me';

/**
 * Direct-message ciphertext, mirroring `MockSignalProtocolClient.encrypt`:
 * prepend the 0x02 SignalMessage marker to the utf-8 payload, then base64.
 * `decrypt` on the receiving side strips the marker back off.
 */
function makeDirectCiphertext(payloadText: string, extra: Partial<{ attachments: Attachment[]; mentions: string[] }> = {}): string {
  const plain = encodePayload({ v: 1, text: payloadText, ...extra });
  const body = utf8ToBytes(plain);
  const out = new Uint8Array(body.length + 1);
  out[0] = 0x02;
  out.set(body, 1);
  return bytesToB64(out);
}

/**
 * Plaintext-path ciphertext (self-DM / @speaker broadcast). The router
 * decodes the raw utf-8 envelope directly with no signal decrypt, so
 * there is NO 0x02 marker — just the base64 of the JSON payload.
 */
function makePlaintextCiphertext(payloadText: string, extra: Partial<{ attachments: Attachment[]; mentions: string[] }> = {}): string {
  const plain = encodePayload({ v: 1, text: payloadText, ...extra });
  return bytesToB64(utf8ToBytes(plain));
}

interface Harness {
  router: (frame: WsServerMsg) => void;
  deps: MessageRouterDeps;
  signal: MockSignalProtocolClient;
  group: MockGroupMessagingClient;
  /** Recorded (conversationId, msg) pairs from addToConversation. */
  added: Array<{ conversationId: string; msg: ChatMessage }>;
  acks: string[];
  notified: Array<Parameters<NonNullable<MessageRouterDeps['notifyInbound']>>[0]>;
  attachmentsSeen: Attachment[][];
}

function makeHarness(over: Partial<MessageRouterDeps> = {}): Harness {
  const signal = new MockSignalProtocolClient();
  const group = new MockGroupMessagingClient({ tag: 'me' });
  const added: Harness['added'] = [];
  const acks: string[] = [];
  const notified: Harness['notified'] = [];
  const attachmentsSeen: Attachment[][] = [];

  const deps: MessageRouterDeps = {
    myUserId: ME,
    api: {} as MessageRouterDeps['api'],
    signalProtocol: signal,
    groupMessaging: group,
    ws: {
      enqueueAck: (id: string) => {
        acks.push(id);
      },
    } as unknown as MessageRouterDeps['ws'],
    orchestrator: {} as MessageRouterDeps['orchestrator'],
    onPrekeysLow: vi.fn(),
    addToConversation: (conversationId, msg) => added.push({ conversationId, msg }),
    markDelivered: vi.fn(),
    markMessageRead: vi.fn(),
    markReadUpTo: vi.fn(),
    ensureGroupHydrated: vi.fn(async () => undefined),
    conversationIdFor: vi.fn((_t, sender) => `dm-${sender}`),
    notifyInbound: (n) => notified.push(n),
    onInboundAttachments: (a) => attachmentsSeen.push(a),
    log: vi.fn(),
    ...over,
  };

  return {
    router: makeMessageRouter(deps),
    deps,
    signal,
    group,
    added,
    acks,
    notified,
    attachmentsSeen,
  };
}

/** Let the in-router `void (async () => …)()` IIFE settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // The session cache + diag buffer are module-level singletons.
  clearSessionCache();
  __resetDiagForTests();
  vi.restoreAllMocks();
});

describe('messageRouter — direct message frame', () => {
  function directFrame(over: Partial<Extract<WsServerMsg, { type: 'message' }>> = {}): WsServerMsg {
    return {
      type: 'message',
      from: 'alice',
      ciphertext: makeDirectCiphertext('hello there'),
      message_id: 'm-1',
      msg_type: 'direct',
      conversation_id: 'dm-alice',
      sent_at: 1000,
      ...over,
    } as WsServerMsg;
  }

  it('decrypts a direct message into the conversation, acks, and notifies', async () => {
    const h = makeHarness();
    h.router(directFrame());
    await flush();

    expect(h.added).toHaveLength(1);
    expect(h.added[0]?.conversationId).toBe('dm-alice');
    expect(h.added[0]?.msg).toMatchObject({
      id: 'm-1',
      from: 'alice',
      text: 'hello there',
      kind: 'direct',
      sentAt: 1000,
      stage: 'sent',
    });
    expect(h.acks).toEqual(['m-1']);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({
      msgId: 'm-1',
      from: 'alice',
      text: 'hello there',
      target: { kind: 'direct', peerId: 'alice' },
    });
  });

  it('marks the peer-established session and stamps implicit read-up-to', async () => {
    const h = makeHarness();
    const noteSpy = vi.spyOn(h.signal, 'decrypt');
    h.router(directFrame({ sent_at: 4242 }));
    await flush();

    // decrypt was driven against the sender
    expect(noteSpy).toHaveBeenCalledWith('alice', expect.any(Uint8Array));
    // implicit read receipts stamp prior outbound bubbles up to sent_at
    expect(h.deps.markReadUpTo).toHaveBeenCalledWith('dm-alice', 4242);
  });

  it('falls back to receive time when sent_at is absent', async () => {
    const h = makeHarness();
    const before = Date.now();
    h.router(directFrame({ sent_at: undefined }));
    await flush();
    const stamped = h.added[0]?.msg.sentAt ?? 0;
    expect(stamped).toBeGreaterThanOrEqual(before);
  });

  it('forwards inbound attachments to onInboundAttachments', async () => {
    const att: Attachment[] = [{ kind: 'image', mime: 'image/jpeg', data: 'AAAA' }];
    const h = makeHarness();
    h.router(directFrame({ ciphertext: makeDirectCiphertext('photo', { attachments: att }) }));
    await flush();

    expect(h.added[0]?.msg.attachments).toEqual(att);
    expect(h.attachmentsSeen).toHaveLength(1);
    expect(h.attachmentsSeen[0]).toEqual(att);
  });

  it('decrypt failure → renders a placeholder bubble, still acks, does NOT notify', async () => {
    const h = makeHarness();
    vi.spyOn(h.signal, 'decrypt').mockRejectedValue(
      new SignalClientError('unknown_error', 'boom'),
    );
    h.router(directFrame());
    await flush();

    expect(h.added).toHaveLength(1);
    expect(h.added[0]?.msg.text).toBe('[couldn’t decrypt this message]');
    // ack still fires so the server drops the buffered row
    expect(h.acks).toEqual(['m-1']);
    // no banner for a failed decrypt
    expect(h.notified).toHaveLength(0);
  });

  it('untrusted-identity decrypt failure → identity-changed bubble', async () => {
    const h = makeHarness();
    vi.spyOn(h.signal, 'decrypt').mockRejectedValue(
      new SignalClientError('untrusted_identity', 'key changed'),
    );
    h.router(directFrame());
    await flush();

    expect(h.added[0]?.msg.text).toBe('[identity changed — verify with peer]');
    expect(h.notified).toHaveLength(0);
  });

  it('malformed base64 ciphertext is dropped without crash or store write', async () => {
    const h = makeHarness();
    expect(() =>
      h.router(directFrame({ ciphertext: '@@@not base64@@@' })),
    ).not.toThrow();
    await flush();
    expect(h.added).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('sealed-sender direct frame (no `from`) is buffered: no store write, no ack', async () => {
    const h = makeHarness();
    h.router(directFrame({ from: undefined }));
    await flush();
    expect(h.added).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('delegates dedup to the store: two identical frames each reach addToConversation', async () => {
    // The router itself does not dedup — the conversations store keys on
    // msg id. The router contract is "call addToConversation once per
    // delivered frame"; we assert it does NOT silently swallow a repeat.
    const h = makeHarness();
    h.router(directFrame());
    h.router(directFrame());
    await flush();
    expect(h.added).toHaveLength(2);
    expect(h.added.every((a) => a.msg.id === 'm-1')).toBe(true);
    expect(h.acks).toEqual(['m-1', 'm-1']);
  });
});

describe('messageRouter — self / @speaker plaintext path', () => {
  it('self-DM decodes utf-8 directly (no signal decrypt), acks, no notify', async () => {
    const h = makeHarness();
    const decryptSpy = vi.spyOn(h.signal, 'decrypt');
    h.router({
      type: 'message',
      from: ME,
      ciphertext: makePlaintextCiphertext('note to self'),
      message_id: 'm-self',
      msg_type: 'direct',
      conversation_id: 'dm-me',
      sent_at: 5,
    } as WsServerMsg);
    await flush();

    expect(decryptSpy).not.toHaveBeenCalled();
    expect(h.added[0]?.msg.text).toBe('note to self');
    expect(h.acks).toEqual(['m-self']);
    // self message: no banner, no implicit read stamp, no attachment auto-save
    expect(h.notified).toHaveLength(0);
    expect(h.deps.markReadUpTo).not.toHaveBeenCalled();
    expect(h.attachmentsSeen).toHaveLength(0);
  });

  it('@speaker broadcast decodes as plaintext (announcements are not E2E)', async () => {
    const h = makeHarness();
    const decryptSpy = vi.spyOn(h.signal, 'decrypt');
    h.router({
      type: 'message',
      from: 'speaker',
      ciphertext: makePlaintextCiphertext('new release out now'),
      message_id: 'm-bcast',
      msg_type: 'direct',
      conversation_id: 'dm-speaker',
    } as WsServerMsg);
    await flush();

    expect(decryptSpy).not.toHaveBeenCalled();
    expect(h.added[0]?.msg.text).toBe('new release out now');
    // not self → notify fires
    expect(h.notified).toHaveLength(1);
  });
});

describe('messageRouter — group / sender-key path', () => {
  /** Build a real group ciphertext from a sender mock that already
   *  created the distribution. Returns base64 wire form. */
  async function makeGroupCiphertext(sender: MockGroupMessagingClient, distId: string, text: string): Promise<string> {
    const bytes = await sender.encryptForGroup(distId, utf8ToBytes(encodePayload({ v: 1, text })));
    return bytesToB64(bytes);
  }

  it('decrypts a group message after the SenderKey is installed', async () => {
    const DIST = 'dist-grp-1';
    const sender = new MockGroupMessagingClient({ tag: 'bob' });
    await sender.createSenderKeyDistribution(DIST);
    const ct = await makeGroupCiphertext(sender, DIST, 'hi room');

    const h = makeHarness();
    // Install the SenderKey on the receiving side as if an SKDM landed.
    await h.group.processSenderKeyDistribution(
      'bob',
      await sender.createSenderKeyDistribution(DIST),
    );

    h.router({
      type: 'message',
      from: 'bob',
      ciphertext: ct,
      message_id: 'g-1',
      msg_type: 'group',
      conversation_id: 'grp-xyz',
      sent_at: 77,
    } as WsServerMsg);
    await flush();

    expect(h.added).toHaveLength(1);
    expect(h.added[0]?.conversationId).toBe('grp-xyz');
    expect(h.added[0]?.msg).toMatchObject({
      id: 'g-1',
      from: 'bob',
      text: 'hi room',
      kind: 'group',
      sentAt: 77,
    });
    expect(h.acks).toEqual(['g-1']);
    expect(h.deps.ensureGroupHydrated).toHaveBeenCalledWith('grp-xyz');
    expect(h.notified[0]).toMatchObject({
      target: { kind: 'group', groupId: 'grp-xyz' },
    });
  });

  it('group decrypt failure (no SenderKey) → placeholder bubble, still acks, no notify', async () => {
    const DIST = 'dist-grp-2';
    const sender = new MockGroupMessagingClient({ tag: 'bob' });
    await sender.createSenderKeyDistribution(DIST);
    const ct = await makeGroupCiphertext(sender, DIST, 'unreadable');

    const h = makeHarness(); // receiver never processed the SKDM
    h.router({
      type: 'message',
      from: 'bob',
      ciphertext: ct,
      message_id: 'g-2',
      msg_type: 'group',
      conversation_id: 'grp-xyz',
    } as WsServerMsg);
    await flush();

    expect(h.added).toHaveLength(1);
    expect(h.added[0]?.msg.text).toBe('[couldn’t decrypt this message]');
    expect(h.acks).toEqual(['g-2']);
    expect(h.notified).toHaveLength(0);
  });

  it('group message awaits an in-flight SKDM from the same sender before decrypting', async () => {
    const DIST = 'dist-race';
    const sender = new MockGroupMessagingClient({ tag: 'carol' });
    await sender.createSenderKeyDistribution(DIST);
    const ct = await makeGroupCiphertext(sender, DIST, 'raced message');
    const skdmBytes = await sender.createSenderKeyDistribution(DIST);

    let releaseSkdm: () => void = () => {};
    const skdmGate = new Promise<void>((res) => {
      releaseSkdm = res;
    });

    const h = makeHarness({
      orchestrator: {
        // Simulate a slow SKDM install: only after the gate opens do we
        // install the SenderKey, so a group message racing ahead must
        // await this promise to decrypt successfully.
        handleIncomingSkdm: vi.fn(async () => {
          await skdmGate;
          await h.group.processSenderKeyDistribution('carol', skdmBytes);
        }),
      } as unknown as MessageRouterDeps['orchestrator'],
    });

    // SKDM frame arrives first and parks in pendingSkdms.
    h.router({
      type: 'skdm',
      from: 'carol',
      group_id: 'grp-race',
      ciphertext: 'irrelevant-mock',
      message_id: 's-1',
    } as WsServerMsg);

    // Group message races in before the SKDM settled.
    h.router({
      type: 'message',
      from: 'carol',
      ciphertext: ct,
      message_id: 'g-race',
      msg_type: 'group',
      conversation_id: 'grp-race',
    } as WsServerMsg);

    await flush();
    // SKDM still gated → group decrypt is parked, nothing added yet.
    expect(h.added).toHaveLength(0);

    releaseSkdm();
    await flush();
    await flush();

    // Now the SenderKey is installed and the parked group message decrypts.
    expect(h.added).toHaveLength(1);
    expect(h.added[0]?.msg.text).toBe('raced message');
    expect(h.acks).toContain('g-race');
  });

  it('group frame missing `from` is dropped (unexpected) with no store write', async () => {
    const h = makeHarness();
    h.router({
      type: 'message',
      from: undefined,
      ciphertext: makeDirectCiphertext('x'),
      message_id: 'g-nofrom',
      msg_type: 'group',
      conversation_id: 'grp-xyz',
    } as WsServerMsg);
    await flush();
    expect(h.added).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });
});

describe('messageRouter — skdm frame', () => {
  it('routes the SKDM envelope to orchestrator.handleIncomingSkdm', async () => {
    const handleIncomingSkdm = vi.fn(async () => undefined);
    const h = makeHarness({
      orchestrator: { handleIncomingSkdm } as unknown as MessageRouterDeps['orchestrator'],
    });
    h.router({
      type: 'skdm',
      from: 'dave',
      group_id: 'grp-1',
      ciphertext: 'ct',
      message_id: 's-9',
    } as WsServerMsg);
    await flush();

    expect(handleIncomingSkdm).toHaveBeenCalledWith({
      from: 'dave',
      group_id: 'grp-1',
      ciphertext: 'ct',
      message_id: 's-9',
    });
  });

  it('does not crash when the SKDM handler rejects', async () => {
    const h = makeHarness({
      orchestrator: {
        handleIncomingSkdm: vi.fn(async () => {
          throw new Error('install failed');
        }),
      } as unknown as MessageRouterDeps['orchestrator'],
    });
    expect(() =>
      h.router({
        type: 'skdm',
        from: 'dave',
        group_id: 'grp-1',
        ciphertext: 'ct',
        message_id: 's-10',
      } as WsServerMsg),
    ).not.toThrow();
    await flush();
  });
});

describe('messageRouter — community message (unwired)', () => {
  it('does NOT ack a community message (kept buffered server-side)', async () => {
    const log = vi.fn();
    const h = makeHarness({ log });
    h.router({
      type: 'message',
      from: 'eve',
      ciphertext: makeDirectCiphertext('community post'),
      message_id: 'c-1',
      msg_type: 'community',
      conversation_id: 'comm-1',
    } as WsServerMsg);
    await flush();
    expect(h.added).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });
});

describe('messageRouter — control & lifecycle frames', () => {
  it('authed fires onAuthed', () => {
    const onAuthed = vi.fn();
    const h = makeHarness({ onAuthed });
    h.router({ type: 'authed', user_id: ME } as WsServerMsg);
    expect(onAuthed).toHaveBeenCalledTimes(1);
  });

  it('pong is a no-op', () => {
    const h = makeHarness();
    expect(() => h.router({ type: 'pong' } as WsServerMsg)).not.toThrow();
    expect(h.added).toHaveLength(0);
  });

  it('error frame is logged', () => {
    const log = vi.fn();
    const h = makeHarness({ log });
    h.router({ type: 'error', code: 'rate_limited', message: 'slow down' } as WsServerMsg);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rate_limited'));
  });

  it('delivered forwards the message id to markDelivered', () => {
    const h = makeHarness();
    h.router({ type: 'delivered', message_id: 'd-1' } as WsServerMsg);
    expect(h.deps.markDelivered).toHaveBeenCalledWith('d-1');
  });

  it('read forwards the message id (with a read timestamp) to markMessageRead', () => {
    const h = makeHarness();
    h.router({ type: 'read', from: 'alice', message_id: 'r-1' } as WsServerMsg);
    expect(h.deps.markMessageRead).toHaveBeenCalledWith('r-1', expect.any(Number));
  });

  it('prekeys_low fires the replenish hook', () => {
    const h = makeHarness();
    h.router({ type: 'prekeys_low', remaining_prekeys: 3 } as WsServerMsg);
    expect(h.deps.onPrekeysLow).toHaveBeenCalledTimes(1);
  });

  it('peer_deleted forwards the handle to onPeerDeleted', () => {
    const onPeerDeleted = vi.fn();
    const h = makeHarness({ onPeerDeleted });
    h.router({ type: 'peer_deleted', handle: 'quiet_fox' } as WsServerMsg);
    expect(onPeerDeleted).toHaveBeenCalledWith('quiet_fox');
  });

  it('channel_key_rotation_required is recorded without crashing', () => {
    const h = makeHarness();
    expect(() =>
      h.router({
        type: 'channel_key_rotation_required',
        community_id: 'comm-1',
        reason: 'member_removed',
      } as WsServerMsg),
    ).not.toThrow();
  });
});

describe('messageRouter — call frames', () => {
  it('routes every call_* frame to onCallFrame', () => {
    const onCallFrame = vi.fn();
    const h = makeHarness({ onCallFrame });
    const frames: WsServerMsg[] = [
      { type: 'call_offer', from: 'alice', call_id: 'c1', ciphertext: 'x' } as WsServerMsg,
      { type: 'call_answer', from: 'alice', call_id: 'c1', ciphertext: 'x' } as WsServerMsg,
      { type: 'call_ice', from: 'alice', call_id: 'c1', ciphertext: 'x' } as WsServerMsg,
      { type: 'call_end', from: 'alice', call_id: 'c1', reason: 'hangup' } as WsServerMsg,
    ];
    for (const f of frames) h.router(f);
    expect(onCallFrame).toHaveBeenCalledTimes(4);
    expect(onCallFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'call_end' }),
    );
  });

  it('does not crash on a call frame when onCallFrame is not wired', () => {
    const h = makeHarness({ onCallFrame: undefined });
    expect(() =>
      h.router({ type: 'call_offer', from: 'alice', call_id: 'c1', ciphertext: 'x' } as WsServerMsg),
    ).not.toThrow();
  });
});
