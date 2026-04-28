/**
 * Cross-instance routing for ack → `delivered` propagation.
 *
 * Phase 3 stopped at "delivered = server has buffered + (if recipient is on
 * THIS instance) forwarded". Phase 4 closes the loop: when a recipient acks,
 * the instance holding the recipient announces the ack on a Redis channel;
 * the instance holding the sender (if any) emits `delivered` to the sender.
 */

export interface AckEvent {
  messageId: string;
  /** Sender to notify with `delivered`. */
  senderId: string;
  /** Originating instance — used to skip self-notifications. */
  instanceId: string;
}

export type AckListener = (ev: AckEvent) => void;

export interface AckRouter {
  /** Publish that `messageId` has been delivered + acked. */
  announce(ev: AckEvent): Promise<void>;
  /** Subscribe to ack events. Listener should ignore events from its own instance. */
  subscribe(listener: AckListener): () => void;
  close(): Promise<void>;
}

/**
 * Single-process router — for tests + single-instance dev. Synchronous
 * fan-out to every subscribed listener.
 */
export class InMemoryAckRouter implements AckRouter {
  private readonly listeners = new Set<AckListener>();

  async announce(ev: AckEvent): Promise<void> {
    for (const l of this.listeners) l(ev);
  }

  subscribe(listener: AckListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}
