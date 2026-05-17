import { describe, expect, it, vi } from 'vitest';
import { sendReplyMessage, type ReplySenderDeps, type ReplyWsClient } from './reply-sender.js';
import { bytesToB64 } from '../utils/bytes.js';

function mockWs(): { ws: ReplyWsClient; sent: WsClientMsgLike[] } {
  const sent: WsClientMsgLike[] = [];
  const ws: ReplyWsClient = {
    connect: vi.fn(),
    waitForAuthed: vi.fn().mockResolvedValue(undefined),
    enqueueSend: vi.fn((m) => sent.push(m as WsClientMsgLike)),
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

    await sendReplyMessage('bob', '  hi there  ', deps);

    expect(encrypt).toHaveBeenCalledWith('bob', expect.any(Uint8Array));
    expect(ws.connect).toHaveBeenCalledOnce();
    expect(ws.waitForAuthed).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'message',
      to: 'bob',
      msg_type: 'direct',
      ciphertext: bytesToB64(new Uint8Array([1, 2, 3])),
    });
    expect(sent[0]!.message_id).toBeTruthy();
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
