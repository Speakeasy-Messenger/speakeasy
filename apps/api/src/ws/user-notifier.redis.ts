import type { Redis } from 'ioredis';
import type { Connections } from './connections.js';
import type { UserNotifier } from './user-notifier.js';

const CHANNEL = 'speakeasy:user-notify';

function raiseRedisListenerLimit(redis: Redis): void {
  const emitter = redis as unknown as {
    getMaxListeners?: () => number;
    setMaxListeners?: (n: number) => void;
  };
  const current = emitter.getMaxListeners?.() ?? 10;
  if (current < 50) emitter.setMaxListeners?.(50);
}

interface NotifyEnvelope {
  userId: string;
  frame: object;
  /** Originating instance — receivers ignore their own publishes. */
  instanceId: string;
}

/**
 * Cross-instance UserNotifier. Mirrors the `RedisAckRouter` pattern.
 *
 * `notify(userId, frame)` does two things:
 *   1. Local fan-out — push to every socket of `userId` on THIS instance.
 *   2. Publish on `speakeasy:user-notify` so peer instances can do the
 *      same for any sockets they own.
 *
 * Each instance subscribes once at construction; on receive it pushes
 * locally if the user has devices here, ignoring publishes from itself
 * (so we don't double-send to local sockets).
 *
 * Two ioredis connections required: ioredis subscribe-mode connections
 * cannot issue commands, so a separate publisher is used. Same convention
 * as `RedisAckRouter`.
 */
export class RedisUserNotifier implements UserNotifier {
  private subscribed = false;

  constructor(
    private readonly connections: Connections,
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly instanceId: string,
  ) {
    raiseRedisListenerLimit(this.subscriber);
    this.ensureSubscribed();
  }

  notify(userId: string, frame: object): void {
    // 1. Local — same as LocalUserNotifier.
    this.deliverLocally(userId, frame);
    // 2. Cross-instance — fire-and-forget; if Redis is down the local
    //    delivery still happened, and the next trigger will retry.
    void this.publisher
      .publish(
        CHANNEL,
        JSON.stringify({ userId, frame, instanceId: this.instanceId } satisfies NotifyEnvelope),
      )
      .catch(() => {
        /* silent — see comment above */
      });
  }

  /** Stop subscribing; safe to call once on shutdown. */
  async close(): Promise<void> {
    if (this.subscribed) await this.subscriber.unsubscribe(CHANNEL);
    this.subscribed = false;
  }

  // ---- internals ----

  private deliverLocally(userId: string, frame: object): void {
    const devices = this.connections.getDevices(userId);
    if (devices.length === 0) return;
    const payload = JSON.stringify(frame);
    for (const socket of devices) {
      try {
        socket.send(payload);
      } catch {
        /* socket may have closed mid-iteration; ignore */
      }
    }
  }

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    void this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      let env: NotifyEnvelope;
      try {
        env = JSON.parse(raw) as NotifyEnvelope;
      } catch {
        return;
      }
      // Ignore self-publishes — we already delivered locally in notify().
      if (env.instanceId === this.instanceId) return;
      this.deliverLocally(env.userId, env.frame);
    });
  }
}
