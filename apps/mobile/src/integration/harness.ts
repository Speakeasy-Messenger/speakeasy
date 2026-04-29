import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../../../api/src/server.js';
import { InMemoryUserRepo } from '../../../api/src/db/users.memory.js';
import { InMemoryPreKeyRepo } from '../../../api/src/db/prekeys.memory.js';
import { InMemoryConnections } from '../../../api/src/ws/connections.js';
import { InMemoryPresence } from '../../../api/src/presence/memory.js';
import { InMemoryMessagesRepo } from '../../../api/src/db/messages.memory.js';
import { InMemoryGroupRepo } from '../../../api/src/db/groups.memory.js';
import { InMemoryCommunityRepo } from '../../../api/src/db/communities.memory.js';
import { MockPushProvider } from '../../../api/src/push/push.mock.js';
import type { WsServerMsg } from '@speakeasy/shared';
import { ApiClient } from '../api/client.js';
import { SpeakeasyWsClient } from '../ws/client.js';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { MockGroupMessagingClient } from '@speakeasy/crypto';
import { makeMessageRouter } from '../ws/message-router.js';
import { makeGroupOrchestrator } from '../crypto/group-orchestration.js';
import { utf8ToBytes, bytesToB64 } from '../utils/bytes.js';
import {
  conversationIdForCommunity,
  conversationIdForDirect,
  conversationIdForGroup,
} from '@speakeasy/shared';
import type { ChatMessage } from '../store/conversations.js';

/**
 * Two-client integration harness.
 *
 * Intent: drive the same JS modules that ship in the APK against a
 * buildServer fixture so we exercise the actual wire path. Two clients,
 * each authed as a different user, can send + receive messages and we
 * assert end-to-end shape.
 *
 * What this catches:
 *   - Hermes-vs-Node bugs (Buffer is deleted in setup; node:* imports
 *     in mobile code surface as test failures because Node's Buffer
 *     behavior differs).
 *   - WS auth-handshake races (the actual SpeakeasyWsClient is in the
 *     loop, with its real waitForAuthed / connect logic).
 *   - Server fan-out, ack/delivered, conversation_id determinism.
 *   - Server-side guards (msg_type validation, peer existence, self-DM
 *     loopback).
 *   - Persistence layer (the AsyncStorage mock from vitest.config.ts
 *     alias is in scope; tests can drive identity hydrate/persist).
 *
 * What this does NOT catch (still need Tier B / device emulator):
 *   - Native module bugs (real libsignal, Vouchflow native bridge).
 *   - UI rendering / React component lifecycle.
 *   - Real Android backgrounding / process kill behavior.
 */

export interface Harness {
  /** Server-side handles. */
  server: {
    app: Awaited<ReturnType<typeof buildServer>>;
    url: string;
    apiBaseUrl: string;
    messagesRepo: InMemoryMessagesRepo;
    userRepo: InMemoryUserRepo;
    preKeyRepo: InMemoryPreKeyRepo;
    push: MockPushProvider;
  };
  /** Tear down server + close every client. */
  teardown: () => Promise<void>;
}

export interface Client {
  userId: string;
  deviceToken: string;
  api: ApiClient;
  ws: SpeakeasyWsClient;
  signalProtocol: MockSignalProtocolClient;
  /** Every WsServerMsg the client has received, in arrival order. */
  received: WsServerMsg[];
  /**
   * Per-conversation message log, populated by the same message-router
   * the mobile app wires in App.tsx. This is what the chat screens
   * render from in production — testing here means we catch bugs
   * between "frame arrived on the WS" and "bubble appeared in chat".
   */
  conversations: Map<string, ChatMessage[]>;
  /** Resolve when the client receives a frame matching the predicate. */
  await: (
    pred: (msg: WsServerMsg) => boolean,
    timeoutMs?: number,
  ) => Promise<WsServerMsg>;
  /** Resolve when a conversation has at least one message satisfying the predicate. */
  awaitMessage: (
    conversationId: string,
    pred: (m: ChatMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ChatMessage>;
  close: () => void;
}

export interface MakeHarnessOptions {
  /**
   * Map of token → user id. Tokens are passed verbatim to the server.
   * The MockValidator binds each token to its corresponding userId
   * (treating it like a pre-enrolled deviceToken). Tokens not in this
   * map fail validation as `device_not_found`.
   */
  users: Record<string, string>;
  /** Optional: pre-populate the user repo for these userIds. Useful for
   *  tests that need PreKey bundles ready (1:1 send path). */
  preEnroll?: string[];
}

export async function makeHarness(opts: MakeHarnessOptions): Promise<Harness> {
  const validator = new MockValidator((tok) => {
    const userId = opts.users[tok];
    if (!userId) return { ok: false, reason: 'device_not_found' };
    return { ok: true, attestation: { confidence: 'medium', userId } };
  });

  const userRepo = new InMemoryUserRepo();
  for (const userId of opts.preEnroll ?? []) {
    await userRepo.tryCreate({
      userId,
      publicKey: Buffer.from(`${userId}-pk`),
      bundle: makeBundle(userId, 30),
    });
  }
  const preKeyRepo = new InMemoryPreKeyRepo(userRepo);
  const messagesRepo = new InMemoryMessagesRepo();
  const push = new MockPushProvider();

  const app = await buildServer({
    validator,
    userRepo,
    preKeyRepo,
    connections: new InMemoryConnections(),
    presence: new InMemoryPresence(),
    messagesRepo,
    groupRepo: new InMemoryGroupRepo(),
    communityRepo: new InMemoryCommunityRepo(),
    push,
    instanceId: 'integration-harness',
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/ws`;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  return {
    server: { app, url, apiBaseUrl, messagesRepo, userRepo, preKeyRepo, push },
    teardown: async () => {
      await app.close();
    },
  };
}

/**
 * Build one mobile-side client tied to a harness. Mounts the real
 * SpeakeasyWsClient + ApiClient, captures every received frame, exposes
 * an `await(predicate)` helper.
 */
export async function makeClient(
  harness: Harness,
  opts: { token: string; userId: string },
): Promise<Client> {
  const api = new ApiClient({ baseUrl: harness.server.apiBaseUrl });
  const signalProtocol = new MockSignalProtocolClient();

  const received: WsServerMsg[] = [];
  const waiters: Array<{
    pred: (m: WsServerMsg) => boolean;
    resolve: (m: WsServerMsg) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const ws = new SpeakeasyWsClient({
    url: harness.server.url,
    getToken: async () => opts.token,
    webSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  // Per-client conversations log — populated by the message router so we
  // exercise the actual bucketing the mobile app does.
  const conversations = new Map<string, ChatMessage[]>();
  const messageWaiters: Array<{
    conversationId: string;
    pred: (m: ChatMessage) => boolean;
    resolve: (m: ChatMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  function addToConversation(conversationId: string, msg: ChatMessage): void {
    let log = conversations.get(conversationId);
    if (!log) {
      log = [];
      conversations.set(conversationId, log);
    }
    log.push(msg);
    for (let i = messageWaiters.length - 1; i >= 0; i--) {
      const w = messageWaiters[i]!;
      if (w.conversationId === conversationId && w.pred(msg)) {
        clearTimeout(w.timer);
        messageWaiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  }

  // Build an orchestrator + message router exactly like App.tsx does.
  const groupMessaging = new MockGroupMessagingClient();
  const distributionIds = new Map<string, string>();
  const orchestrator = makeGroupOrchestrator({
    api,
    signalProtocol,
    groupMessaging,
    ws,
    getDeviceToken: async () => opts.token,
    getOrCreateDistributionId: (groupId) => {
      let id = distributionIds.get(groupId);
      if (!id) {
        id = `dist-${groupId.slice(0, 8)}-${opts.userId}`;
        distributionIds.set(groupId, id);
      }
      return id;
    },
  });
  const router = makeMessageRouter({
    myUserId: opts.userId,
    api,
    signalProtocol,
    groupMessaging,
    ws,
    orchestrator,
    onPrekeysLow: () => {
      /* no-op for the harness */
    },
    addToConversation,
    conversationIdFor: (kind, senderId, to) => {
      switch (kind) {
        case 'direct':
          return conversationIdForDirect(senderId, to);
        case 'group':
          return conversationIdForGroup(to);
        case 'community':
          return conversationIdForCommunity(to);
      }
    },
  });

  ws.subscribe((msg) => {
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });
  ws.subscribe(router);

  ws.connect();
  await ws.waitForAuthed(5000);

  return {
    userId: opts.userId,
    deviceToken: opts.token,
    api,
    ws,
    signalProtocol,
    received,
    conversations,
    async await(pred, timeoutMs = 2000) {
      const existing = received.find(pred);
      if (existing) return existing;
      return new Promise<WsServerMsg>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`await timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    async awaitMessage(conversationId, pred, timeoutMs = 2000) {
      const existing = (conversations.get(conversationId) ?? []).find(pred);
      if (existing) return existing;
      return new Promise<ChatMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = messageWaiters.findIndex((w) => w.timer === timer);
          if (i >= 0) messageWaiters.splice(i, 1);
          reject(
            new Error(`awaitMessage timeout (${conversationId}) after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        messageWaiters.push({ conversationId, pred, resolve, timer });
      });
    },
    close: () => ws.close(),
  };
}

/**
 * Helper: send a direct message from a client. Wraps utf-8 encode +
 * b64 + ws.send so tests stay readable. Caller-supplied peerUserId is
 * the message's `to`; for self-DM, pass the sender's own userId.
 *
 * For non-self peers this performs `signalProtocol.encrypt` (mock — just
 * adds a marker byte). For self-DM, sends utf-8 plaintext directly,
 * matching the production self-DM bypass in ChatScreen.
 */
export async function sendDirect(
  client: Client,
  peerUserId: string,
  text: string,
): Promise<void> {
  const plaintext = utf8ToBytes(text);
  const ciphertext =
    peerUserId === client.userId
      ? plaintext
      : await client.signalProtocol.encrypt(peerUserId, plaintext);
  client.ws.send({
    type: 'message',
    to: peerUserId,
    ciphertext: bytesToB64(ciphertext),
    msg_type: 'direct',
  });
}

interface BundleSeed {
  registrationId: number;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  preKeys: Array<{ id: number; key: string }>;
}
function makeBundle(seed: string, prekeyCount: number): BundleSeed {
  return {
    registrationId: (seed.charCodeAt(0) || 1) * 31 + 1,
    signedPreKeyId: 1,
    signedPreKey: Buffer.from(`${seed}-spk`).toString('base64'),
    signedPreKeySig: Buffer.from(`${seed}-sig`).toString('base64'),
    preKeys: Array.from({ length: prekeyCount }, (_, i) => ({
      id: i + 1,
      key: Buffer.from(`${seed}-otpk-${i + 1}`).toString('base64'),
    })),
  };
}
