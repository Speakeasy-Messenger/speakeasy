import { describe, expect, it, vi } from 'vitest';
import {
  sendReplyMessage,
  sendGroupReplyMessage,
  type ReplySenderDeps,
  type GroupReplySenderDeps,
  type ReplyWsClient,
} from './reply-sender.js';
import { bytesToB64 } from '../utils/bytes.js';

function mockWs(): { ws: ReplyWsClient; sent: WsClientMsgLike[] } {
  const sent: WsClientMsgLike[] = [];
  const ws: ReplyWsClient = {
    connect: vi.fn(),
    waitForAuthed: vi.fn().mockResolvedValue(undefined),
    enqueueSend: vi.fn((m) => sent.push(m as WsClientMsgLike)),
    queueSend: vi.fn(async (m) => {
      sent.push(m as WsClientMsgLike);
    }),
  };
  return { ws, sent };
}

interface WsClientMsgLike {
  type: string;
  to: string;
  ciphertext: string;
  msg_type: string;
  message_id: string;
}

describe('sendReplyMessage', () => {
  it('encrypts the reply and sends a direct message frame', async () => {
    const { ws, sent } = mockWs();
    const encrypt = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const deps: ReplySenderDeps = {
      encrypt,
      getWsClient: () => ws,
      loadDeviceToken: async () => 'dvt_test',
      settleMs: 0,
    };

    const result = await sendReplyMessage('bob', '  hi there  ', deps);

    expect(encrypt).toHaveBeenCalledWith('bob', expect.any(Uint8Array));
    expect(ws.connect).toHaveBeenCalledOnce();
    expect(ws.waitForAuthed).toHaveBeenCalledOnce();
    expect(ws.queueSend).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'message',
      to: 'bob',
      msg_type: 'direct',
      ciphertext: bytesToB64(new Uint8Array([1, 2, 3])),
    });
    expect(sent[0]!.message_id).toBeTruthy();
  });

  it('returns the wire message_id so the caller can match read receipts', async () => {
    // The id on the returned object MUST equal the id sent on the wire.
    // The in-app copy of the reply is recorded under it; the peer's read
    // receipt references the wire id. A mismatch leaves inline replies
    // permanently un-receipted (reported 2026-05-19).
    const { ws, sent } = mockWs();
    const deps: ReplySenderDeps = {
      encrypt: vi.fn().mockResolvedValue(new Uint8Array([9])),
      getWsClient: () => ws,
      loadDeviceToken: async () => 'dvt_test',
      settleMs: 0,
    };

    const { messageId } = await sendReplyMessage('bob', 'hi', deps);

    expect(messageId).toBeTruthy();
    expect(messageId).toBe(sent[0]!.message_id);
  });

  it('waits for the queued send to flush before returning success', async () => {
    const sent: WsClientMsgLike[] = [];
    let flush: (() => void) | undefined;
    const ws: ReplyWsClient = {
      connect: vi.fn(),
      waitForAuthed: vi.fn().mockResolvedValue(undefined),
      enqueueSend: vi.fn(),
      queueSend: vi.fn(
        (m) =>
          new Promise<void>((resolve) => {
            sent.push(m as WsClientMsgLike);
            flush = resolve;
          }),
      ),
    };
    const deps: ReplySenderDeps = {
      encrypt: vi.fn().mockResolvedValue(new Uint8Array([9])),
      getWsClient: () => ws,
      loadDeviceToken: async () => 'dvt_test',
      settleMs: 0,
    };

    let resolved = false;
    const pending = sendReplyMessage('bob', 'hi', deps).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(resolved).toBe(false);

    flush?.();
    await pending;
    expect(resolved).toBe(true);
  });

  it('throws when no device token is stored', async () => {
    const { ws } = mockWs();
    const deps: ReplySenderDeps = {
      encrypt: vi.fn(),
      getWsClient: () => ws,
      loadDeviceToken: async () => undefined,
      settleMs: 0,
    };
    await expect(sendReplyMessage('bob', 'hi', deps)).rejects.toThrow('no_device_token');
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it('throws on an empty reply without touching the network', async () => {
    const { ws } = mockWs();
    const encrypt = vi.fn();
    const deps: ReplySenderDeps = {
      encrypt,
      getWsClient: () => ws,
      loadDeviceToken: async () => 'dvt_test',
      settleMs: 0,
    };
    await expect(sendReplyMessage('bob', '   ', deps)).rejects.toThrow('empty_reply');
    expect(encrypt).not.toHaveBeenCalled();
  });
});

describe('sendGroupReplyMessage', () => {
  it('fans the reply out through the orchestrator with the group members', async () => {
    const sendGroupMessage = vi.fn().mockResolvedValue(undefined);
    const deps: GroupReplySenderDeps = {
      sendGroupMessage,
      members: ['me', 'alice', 'bob'],
      selfUserId: 'me',
      settleMs: 0,
    };

    const { messageId } = await sendGroupReplyMessage('grp-1', '  hey all  ', deps);

    expect(sendGroupMessage).toHaveBeenCalledOnce();
    expect(sendGroupMessage).toHaveBeenCalledWith({
      groupId: 'grp-1',
      members: ['me', 'alice', 'bob'],
      selfUserId: 'me',
      plaintext: expect.any(Uint8Array),
    });
    // A local echo id is minted (group frames carry no client message_id).
    expect(messageId).toBeTruthy();
  });

  it('throws on an empty reply without touching the orchestrator', async () => {
    const sendGroupMessage = vi.fn();
    const deps: GroupReplySenderDeps = {
      sendGroupMessage,
      members: ['me', 'alice'],
      selfUserId: 'me',
      settleMs: 0,
    };
    await expect(sendGroupReplyMessage('grp-1', '   ', deps)).rejects.toThrow('empty_reply');
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('propagates an orchestrator send failure to the caller', async () => {
    const deps: GroupReplySenderDeps = {
      sendGroupMessage: vi.fn().mockRejectedValue(new Error('skdm_bootstrap_failed')),
      members: ['me', 'alice'],
      selfUserId: 'me',
      settleMs: 0,
    };
    await expect(sendGroupReplyMessage('grp-1', 'hi', deps)).rejects.toThrow(
      'skdm_bootstrap_failed',
    );
  });
});
