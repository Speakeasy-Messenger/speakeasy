/**
 * WS load test — ack routing + delivery under concurrency.
 *
 * Spins up a Fastify instance, connects N sender WS and 1 recipient WS,
 * hammers message sends, and verifies that `delivered` events propagate
 * back after the recipient acks.
 *
 * Limitation: cross-instance (sender on A, recipient on B) live forwarding
 * is not yet implemented — messages are only buffered + push-notified when
 * the recipient is on a different instance. The recipient would need to
 * reconnect to drain the buffer. This test uses a single instance.
 * Set REDIS_URL to use RedisAckRouter (verifies the pub/sub plumbing).
 *
 * Run:  npm run test:load
 *       REDIS_URL=redis://... npm run test:load
 */
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { InMemoryAckRouter } from '../src/ws/ack-router.js';
import { InMemoryConnections } from '../src/ws/connections.js';
import { InMemoryPresence } from '../src/presence/memory.js';
import { InMemoryMessagesRepo } from '../src/db/messages.memory.js';
import { InMemoryGroupRepo } from '../src/db/groups.memory.js';
import { InMemoryCommunityRepo } from '../src/db/communities.memory.js';
import { InMemoryDevicesRepo } from '../src/db/devices.memory.js';
import { InMemoryUserRepo } from '../src/db/users.memory.js';
import { InMemoryPreKeyRepo } from '../src/db/prekeys.memory.js';
import { MockPushProvider } from '../src/push/push.mock.js';
import type { AckRouter } from '../src/ws/ack-router.js';
import { Redis } from 'ioredis';
import { RedisAckRouter } from '../src/ws/ack-router.redis.js';
import { MockValidator, type Validator } from '@speakeasy/vouchflow';
import type { AddressInfo } from 'net';

const CONCURRENT = 20;
const MESSAGES_PER_SENDER = 10;

async function main() {
  const ackRouter: AckRouter = await resolveAckRouter();
  const validator = MockValidator.alwaysSucceeds();

  const app = await buildInstance(ackRouter, validator);
  const port = (app.server.address() as AddressInfo).port;
  console.log(`Server on :${port}`);

  // MockValidator.alwaysSucceeds() — every deviceToken passes validation

  // Auth recipient first, then N senders
  const recipientWs = await authedWs(port, `dvt_recip`);
  const senderSockets: WebSocket[] = [];
  for (let i = 0; i < CONCURRENT; i++) {
    senderSockets.push(await authedWs(port, `dvt_sender_${i}`));
  }
  console.log(`${CONCURRENT} senders + 1 recipient connected`);

  // Track delivered events across all sender sockets
  const delivered = new Set<string>();
  for (const ws of senderSockets) {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'delivered') delivered.add(msg.message_id);
      } catch { /* ignore */ }
    });
  }

  // Recipient auto-acks every message
  recipientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'message') {
        recipientWs.send(JSON.stringify({ type: 'ack', message_id: msg.message_id }));
      }
    } catch { /* ignore */ }
  });

  await sleep(100);

  // Send messages concurrently across all senders
  const start = performance.now();
  let sentCount = 0;
  const sendPromises: Promise<void>[] = [];

  for (let i = 0; i < CONCURRENT; i++) {
    sendPromises.push(
      (async () => {
        for (let j = 0; j < MESSAGES_PER_SENDER; j++) {
          senderSockets[i]!.send(
            JSON.stringify({
              type: 'message',
              to: 'load-recip-id',
              ciphertext: Buffer.from(`payload-${i}-${j}`).toString('base64'),
              msg_type: 'direct',
            }),
          );
          sentCount++;
        }
      })(),
    );
  }

  await Promise.all(sendPromises);
  const sendDone = performance.now();

  // Wait for all delivered acks (with timeout)
  const expected = CONCURRENT * MESSAGES_PER_SENDER;
  const deadline = Date.now() + 15_000;
  while (delivered.size < expected && Date.now() < deadline) {
    await sleep(100);
  }
  const ackDone = performance.now();

  const totalMs = ackDone - start;
  const sendMs = sendDone - start;

  console.log('\n--- Results ---');
  console.log(`Sent:       ${sentCount}`);
  console.log(`Delivered:  ${delivered.size}/${expected}`);
  console.log(`Send time:  ${sendMs.toFixed(0)}ms`);
  console.log(`Total time: ${totalMs.toFixed(0)}ms`);
  console.log(
    `Throughput: ${((sentCount / totalMs) * 1000).toFixed(0)} msg/s`,
  );

  // Cleanup
  for (const ws of senderSockets) ws.close();
  recipientWs.close();
  await app.close();
  await ackRouter.close();

  const success = delivered.size === expected;
  console.log(success ? '\n✅ PASS' : `\n❌ FAIL (${expected - delivered.size} missing)`);
  process.exit(success ? 0 : 1);
}

async function authedWs(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  const authed = await new Promise<any>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
  if (authed.type !== 'authed') {
    throw new Error(`Auth failed: ${JSON.stringify(authed)}`);
  }
  return ws;
}

async function buildInstance(
  ackRouter: AckRouter,
  validator: Validator,
): Promise<FastifyInstance> {
  const repo = new InMemoryUserRepo();
  const app = await buildServer({
    validator,
    userRepo: repo,
    preKeyRepo: new InMemoryPreKeyRepo(repo),
    groupRepo: new InMemoryGroupRepo(),
    communityRepo: new InMemoryCommunityRepo(),
    messagesRepo: new InMemoryMessagesRepo(),
    devicesRepo: new InMemoryDevicesRepo(),
    ackRouter,
    push: new MockPushProvider(),
    connections: new InMemoryConnections(),
    presence: new InMemoryPresence(),
    instanceId: 'load-test',
    logger: { level: 'warn' },
    skipWebsocket: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

async function resolveAckRouter(): Promise<AckRouter> {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    console.log(`Using RedisAckRouter (${redisUrl})`);
    const pub = new Redis(redisUrl);
    const sub = new Redis(redisUrl);
    return new RedisAckRouter(pub, sub);
  }
  console.log('Using InMemoryAckRouter (set REDIS_URL for Redis)');
  return new InMemoryAckRouter();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
