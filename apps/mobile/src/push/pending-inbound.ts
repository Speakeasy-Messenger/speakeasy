import { secureKv } from '../native/secure-kv.js';
import type { ChatMessage } from '../store/conversations.js';

/**
 * Small encrypted inbox for messages already decrypted by the Android
 * background-push handler.
 *
 * The headless JS store is intentionally not hydrated: writing directly to
 * Zustand there could overwrite the real conversation history. Instead, the
 * push handler appends to this SQLCipher-backed queue. The foreground
 * conversation hydrate drains it before waiting for WebSocket replay.
 */
const PENDING_INBOUND_KEY = 'speakeasy.pending-inbound.v1';
const MAX_PENDING_INBOUND = 200;

export interface PendingInboundMessage {
  conversationId: string;
  message: ChatMessage;
}

let mutationChain: Promise<void> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(work, work);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readQueue(): Promise<PendingInboundMessage[]> {
  const raw = await secureKv.get(PENDING_INBOUND_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is PendingInboundMessage =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as PendingInboundMessage).conversationId === 'string' &&
      typeof (item as PendingInboundMessage).message?.id === 'string',
  );
}

async function writeQueue(queue: PendingInboundMessage[]): Promise<void> {
  if (queue.length === 0) {
    await secureKv.delete(PENDING_INBOUND_KEY);
    return;
  }
  await secureKv.set(PENDING_INBOUND_KEY, JSON.stringify(queue));
}

/** Append one background-decrypted message, deduplicated by server id. */
export function enqueuePendingInboundMessage(
  pending: PendingInboundMessage,
): Promise<void> {
  return serialize(async () => {
    const queue = await readQueue();
    if (queue.some((item) => item.message.id === pending.message.id)) return;
    await writeQueue([...queue, pending].slice(-MAX_PENDING_INBOUND));
  });
}

/**
 * Merge the encrypted inbox into the hydrated conversation store.
 *
 * The main store is flushed before processed inbox records are removed. If
 * the process dies between those two operations, the inbox safely replays on
 * the next launch and the conversation store's message-id guard deduplicates
 * it.
 */
export function drainPendingInboundMessages(deps: {
  add: (conversationId: string, message: ChatMessage) => void;
  persist: () => Promise<void>;
}): Promise<number> {
  return serialize(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return 0;

    for (const pending of queue) {
      deps.add(pending.conversationId, pending.message);
    }
    await deps.persist();

    const processedIds = new Set(queue.map((item) => item.message.id));
    const latest = await readQueue();
    await writeQueue(latest.filter((item) => !processedIds.has(item.message.id)));
    return queue.length;
  });
}

/** Account-reset cleanup so one identity cannot inherit another's inbox. */
export function clearPendingInboundMessages(): Promise<void> {
  return serialize(() => secureKv.delete(PENDING_INBOUND_KEY));
}
