import { describe, expect, it } from 'vitest';
import { makeGroupOrchestrator } from './group-orchestration.js';
import { clearSessionCache } from './session.js';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { MockGroupMessagingClient } from '@speakeasy/crypto';
import type { ApiClient, PreKeyBundleResponse } from '../api/client.js';
import type { SpeakeasyWsClient } from '../ws/client.js';
import type { WsClientMsg } from '@speakeasy/shared';

const DIST_ID = 'a3a1b2c3-d4e5-46f7-a890-123456789abc';

interface CapturedFrame {
  frame: WsClientMsg;
}

function makeFakeWs(): { ws: SpeakeasyWsClient; sent: CapturedFrame[] } {
  const sent: CapturedFrame[] = [];
  const ws = {
    send: (frame: WsClientMsg) => {
      sent.push({ frame });
    },
    // The orchestrator now re-confirms `authed` immediately before each
    // ws.send (alpha-0.4.7 reconnect-loop fix). Stub these out so the
    // unit tests don't have to model the full WS state machine.
    getState: () => 'authed' as const,
    waitForAuthed: async () => {},
    enqueueAck: (id: string) => {
      sent.push({ frame: { type: 'ack', message_id: id } as WsClientMsg });
    },
  } as unknown as SpeakeasyWsClient;
  return { ws, sent };
}

function makeFakeApi(bundle: PreKeyBundleResponse): ApiClient {
  return {
    async fetchPreKeyBundle(): Promise<PreKeyBundleResponse> {
      return bundle;
    },
  } as unknown as ApiClient;
}

function bundleFor(userId: string): PreKeyBundleResponse {
  return {
    user_id: userId,
    identity_public_key: 'AAAA',
    registration_id: 1,
    signed_prekey_id: 1,
    signed_prekey: 'AAAA',
    signed_prekey_sig: 'AAAA',
    one_time_prekey: { id: 1, key: 'AAAA' },
    remaining_prekeys: 100,
    low_water: false,
  };
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

describe('makeGroupOrchestrator', () => {
  it('first send fans SKDM to every other member, then sends the group ciphertext', async () => {
    clearSessionCache();
    const signalProtocol = new MockSignalProtocolClient();
    const groupMessaging = new MockGroupMessagingClient();
    const { ws, sent } = makeFakeWs();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol,
      groupMessaging,
      ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });

    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob', 'carol'],
      selfUserId: 'alice',
      plaintext: utf8('hello group'),
    });

    // 1 skdm to bob + 1 skdm to carol + 1 group message frame.
    expect(sent.map((s) => s.frame.type)).toEqual(['skdm', 'skdm', 'message']);
    expect((sent[0]!.frame as Extract<WsClientMsg, { type: 'skdm' }>).to).toBe('bob');
    expect((sent[0]!.frame as Extract<WsClientMsg, { type: 'skdm' }>).group_id).toBe('grp-1');
    expect((sent[1]!.frame as Extract<WsClientMsg, { type: 'skdm' }>).to).toBe('carol');
    expect((sent[2]!.frame as Extract<WsClientMsg, { type: 'message' }>).msg_type).toBe('group');
  });

  it('skips the SKDM fan-out on subsequent sends in the same process', async () => {
    clearSessionCache();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: new MockSignalProtocolClient(),
      groupMessaging: new MockGroupMessagingClient(),
      ws: makeFakeWs().ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });
    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('first'),
    });

    const second = makeFakeWs();
    const orch2 = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: new MockSignalProtocolClient(),
      groupMessaging: new MockGroupMessagingClient(),
      ws: second.ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });
    // re-using a fresh orchestrator should ALSO bootstrap once — proves
    // the bootstrap cache is per-orchestrator, not global.
    await orch2.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('first via orch2'),
    });
    expect(second.sent.map((s) => s.frame.type)).toEqual(['skdm', 'message']);
    // Now hit orch2 again — only the message frame this time.
    await orch2.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('subsequent'),
    });
    expect(second.sent.map((s) => s.frame.type)).toEqual(['skdm', 'message', 'message']);
  });

  it('bootstraps a newly-added member without re-sending SKDMs to existing ones', async () => {
    clearSessionCache();
    const { ws, sent } = makeFakeWs();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: new MockSignalProtocolClient(),
      groupMessaging: new MockGroupMessagingClient(),
      ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });
    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('initial'),
    });
    // First round: 1 skdm (bob) + 1 group msg.
    expect(sent.length).toBe(2);

    // Now add carol.
    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob', 'carol'],
      selfUserId: 'alice',
      plaintext: utf8('with carol'),
    });
    // Second round: 1 skdm (carol only — bob already bootstrapped) + 1 group msg.
    expect(sent.length).toBe(4);
    expect((sent[2]!.frame as Extract<WsClientMsg, { type: 'skdm' }>).to).toBe('carol');
    expect(sent[3]!.frame.type).toBe('message');
  });

  it('redistributeSenderKey re-sends an SKDM to a single peer (answers skdm_request)', async () => {
    clearSessionCache();
    const { ws, sent } = makeFakeWs();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: new MockSignalProtocolClient(),
      groupMessaging: new MockGroupMessagingClient(),
      ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });

    // A member who can't decrypt our messages asked us to re-send. We push
    // exactly one SKDM, to just them — no group message, no fan-out.
    await orch.redistributeSenderKey('grp-1', 'carol');
    expect(sent.length).toBe(1);
    expect(sent[0]!.frame.type).toBe('skdm');
    const skdm = sent[0]!.frame as Extract<WsClientMsg, { type: 'skdm' }>;
    expect(skdm.to).toBe('carol');
    expect(skdm.group_id).toBe('grp-1');
  });

  it('handleIncomingSkdm decrypts via 1:1, installs SenderKey, acks', async () => {
    clearSessionCache();
    // Two parallel mock universes — alice (sender) and bob (recipient).
    // We pre-establish a round-trip via the mock signal protocol's
    // identity encrypt (it's just a 0x02-prefix byte) so bob can
    // "decrypt" alice's SKDM envelope. The test asserts the orchestrator
    // wiring, not the crypto — that's what mock-group-messaging tests cover.
    const aliceGroupMsg = new MockGroupMessagingClient();
    await aliceGroupMsg.createSenderKeyDistribution(DIST_ID);
    const skdmBytes = await aliceGroupMsg.createSenderKeyDistribution(DIST_ID);
    // Wrap the SKDM bytes the way the real encrypt would — the mock
    // signal protocol prepends a 0x02 marker; our orchestrator's
    // handleIncomingSkdm calls decrypt() which strips that marker.
    const aliceSignal = new MockSignalProtocolClient();
    const wrapped = await aliceSignal.encrypt('bob', skdmBytes);

    const bobGroupMsg = new MockGroupMessagingClient();
    const bobSignal = new MockSignalProtocolClient();
    const { ws, sent } = makeFakeWs();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: bobSignal,
      groupMessaging: bobGroupMsg,
      ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });

    await orch.handleIncomingSkdm({
      from: 'alice',
      group_id: 'grp-1',
      ciphertext: Buffer.from(wrapped).toString('base64'),
      message_id: 'msg-skdm-1',
    });

    // Bob's groupMessaging should now know about alice's SenderKey.
    // Round-trip a real group message: alice encrypts, bob decrypts.
    const groupCt = await aliceGroupMsg.encryptForGroup(DIST_ID, utf8('after-skdm'));
    const plaintext = await bobGroupMsg.decryptFromGroupMember('alice', groupCt);
    expect(Buffer.from(plaintext).toString('utf8')).toBe('after-skdm');

    // And the orchestrator should have acked the SKDM.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame).toEqual({ type: 'ack', message_id: 'msg-skdm-1' });
  });

  it('reset() drops bootstrap cache so the next send re-fans', async () => {
    clearSessionCache();
    const { ws, sent } = makeFakeWs();
    const orch = makeGroupOrchestrator({
      api: makeFakeApi(bundleFor('any')),
      signalProtocol: new MockSignalProtocolClient(),
      groupMessaging: new MockGroupMessagingClient(),
      ws,
      getDeviceToken: async () => 'dvt_test',
      getOrCreateDistributionId: () => DIST_ID,
    });
    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('a'),
    });
    expect(sent.length).toBe(2);

    orch.reset();
    await orch.sendGroupMessage({
      groupId: 'grp-1',
      members: ['alice', 'bob'],
      selfUserId: 'alice',
      plaintext: utf8('b'),
    });
    // Post-reset we should refan: 1 skdm + 1 message.
    expect(sent.length).toBe(4);
    expect(sent[2]!.frame.type).toBe('skdm');
  });
});
