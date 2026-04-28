import type { Redis } from 'ioredis';
import type { AckEvent, AckListener, AckRouter } from './ack-router.js';

const CHANNEL = 'speakeasy:ack';

/**
 * Redis Pub/Sub-backed ack router. Uses TWO connections (a publisher and a
 * subscriber) per ioredis convention — a single connection in subscribe
 * mode can't issue commands.
 */
export class RedisAckRouter implements AckRouter {
  private readonly listeners = new Set<AckListener>();
  private subscribed = false;

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {}

  async announce(ev: AckEvent): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify(ev));
  }

  subscribe(listener: AckListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      void this.subscriber.subscribe(CHANNEL);
      this.subscriber.on('message', (channel, raw) => {
        if (channel !== CHANNEL) return;
        try {
          const ev = JSON.parse(raw) as AckEvent;
          for (const l of this.listeners) l(ev);
        } catch {
          /* drop malformed */
        }
      });
    }
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.subscribed) await this.subscriber.unsubscribe(CHANNEL);
    this.listeners.clear();
  }
}
