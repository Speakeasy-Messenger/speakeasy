import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisUserNotifier } from './user-notifier.redis.js';
import { InMemoryConnections } from './connections.js';

/**
 * Minimal in-memory Redis stand-in covering just the pub/sub surface
 * `RedisUserNotifier` uses. Lets us verify cross-instance fan-out
 * without a real Redis. Same `RedisShim` pattern as the AckRouter
 * tests would use if we had one.
 */
class FakeRedisChannel {
  private readonly subscribers = new Set<(channel: string, raw: string) => void>();
  publish(channel: string, raw: string): void {
    for (const fn of this.subscribers) fn(channel, raw);
  }
  addMessageHandler(fn: (channel: string, raw: string) => void): void {
    this.subscribers.add(fn);
  }
}

function pair(bus: FakeRedisChannel): { pub: Redis; sub: Redis } {
  let onMessage: ((channel: string, raw: string) => void) | undefined;
  const pub = {
    publish(channel: string, raw: string): Promise<number> {
      bus.publish(channel, raw);
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  const sub = {
    subscribe(_channel: string): Promise<void> {
      if (onMessage) bus.addMessageHandler(onMessage);
      return Promise.resolve();
    },
    on(event: string, handler: (channel: string, raw: string) => void): Redis {
      if (event !== 'message') return sub;
      onMessage = handler;
      bus.addMessageHandler(handler);
      return sub;
    },
    unsubscribe(_channel: string): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as Redis;
  return { pub, sub };
}

interface FakeSocket {
  send(payload: string): void;
  readonly received: string[];
}

function fakeSocket(): FakeSocket {
  const received: string[] = [];
  return {
    received,
    send(payload) {
      received.push(payload);
    },
  };
}

async function attachSocket(
  conns: InMemoryConnections,
  userId: string,
  deviceToken: string,
): Promise<FakeSocket> {
  const sock = fakeSocket();
  await conns.add(userId, deviceToken, sock as unknown as never);
  return sock;
}

describe('RedisUserNotifier', () => {
  it('delivers locally to all live sockets of the user (same as LocalUserNotifier)', async () => {
    const bus = new FakeRedisChannel();
    const { pub, sub } = pair(bus);
    const conns = new InMemoryConnections();
    const phone = await attachSocket(conns, 'alice', 'dvtPhone');
    const laptop = await attachSocket(conns, 'alice', 'dvtLaptop');

    const notifier = new RedisUserNotifier(conns, pub, sub, 'instance-A');
    notifier.notify('alice', { type: 'prekeys_low', remaining_prekeys: 5 });

    const expected = JSON.stringify({ type: 'prekeys_low', remaining_prekeys: 5 });
    expect(phone.received).toEqual([expected]);
    expect(laptop.received).toEqual([expected]);
  });

  it('publishes cross-instance — peer instance delivers to its own sockets', async () => {
    const bus = new FakeRedisChannel();
    // Instance A: holds no sockets for alice (her phone is on instance B).
    const aConns = new InMemoryConnections();
    const aPair = pair(bus);
    const aNotifier = new RedisUserNotifier(aConns, aPair.pub, aPair.sub, 'instance-A');

    // Instance B: holds alice's only live socket.
    const bConns = new InMemoryConnections();
    const bPair = pair(bus);
    const _bNotifier = new RedisUserNotifier(bConns, bPair.pub, bPair.sub, 'instance-B');
    const phone = await attachSocket(bConns, 'alice', 'dvtPhone');

    aNotifier.notify('alice', { type: 'prekeys_low', remaining_prekeys: 7 });

    // Allow the publish→subscribe round-trip to flush.
    await new Promise((r) => setImmediate(r));

    expect(phone.received).toEqual([
      JSON.stringify({ type: 'prekeys_low', remaining_prekeys: 7 }),
    ]);
  });

  it('does not double-send on the originating instance', async () => {
    const bus = new FakeRedisChannel();
    const conns = new InMemoryConnections();
    const phone = await attachSocket(conns, 'alice', 'dvtPhone');
    const { pub, sub } = pair(bus);
    const notifier = new RedisUserNotifier(conns, pub, sub, 'instance-A');

    notifier.notify('alice', { type: 'prekeys_low', remaining_prekeys: 3 });
    await new Promise((r) => setImmediate(r));

    // Local delivery once + cross-instance receive ignored (matching
    // instanceId) — exactly one frame.
    expect(phone.received).toHaveLength(1);
  });

  it('skips delivery when the user has no local devices and no peer holds them', async () => {
    const bus = new FakeRedisChannel();
    const conns = new InMemoryConnections();
    const { pub, sub } = pair(bus);
    const notifier = new RedisUserNotifier(conns, pub, sub, 'instance-A');

    // No throw, no frame anywhere — silent drop is the correct behaviour
    // for offline users (push notifications are a separate channel).
    expect(() => notifier.notify('ghost', { type: 'prekeys_low', remaining_prekeys: 1 }))
      .not.toThrow();
  });
});
