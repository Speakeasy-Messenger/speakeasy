import { secureKv } from '../native/secure-kv.js';

const PUSH_MUTES_KEY = 'speakeasy.push-mutes.v1';
// Kept in sync with store/conversations.ts. This fallback is intentionally
// local to the push layer to avoid a circular dependency from the headless
// handler back through the Zustand store.
const CONVERSATIONS_KEY = 'speakeasy.conversations.v1';
let writeChain: Promise<void> = Promise.resolve();

/**
 * Persist only the muted conversation ids in a small encrypted record.
 * Background push must not hydrate and parse the full message history just
 * to answer this one-bit question.
 */
export function persistPushMuteSnapshot(
  conversations: Record<string, { muted?: boolean }>,
): Promise<void> {
  const muted = Object.entries(conversations)
    .filter(([, conversation]) => conversation.muted === true)
    .map(([conversationId]) => conversationId);
  const write = () => secureKv.set(PUSH_MUTES_KEY, JSON.stringify(muted));
  const run = writeChain.then(write, write);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Fail open when the encrypted DB is unavailable or the index predates this
 * build: showing a notification is safer than silently dropping one.
 */
export async function shouldSuppressPushForMute(
  conversationId: string | undefined,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    await writeChain;
    const raw = await secureKv.get(PUSH_MUTES_KEY);
    if (raw) {
      const muted = JSON.parse(raw) as unknown;
      return Array.isArray(muted) && muted.includes(conversationId);
    }

    // One-time upgrade path: builds predating the compact mute snapshot only
    // have the encrypted conversation store. Derive and persist the index on
    // the first headless push so an already-muted chat does not leak a banner
    // before the user opens the upgraded app.
    const conversationsRaw = await secureKv.get(CONVERSATIONS_KEY);
    const conversations = conversationsRaw
      ? (JSON.parse(conversationsRaw) as Record<string, { muted?: boolean }>)
      : {};
    await persistPushMuteSnapshot(conversations);
    return conversations[conversationId]?.muted === true;
  } catch {
    return false;
  }
}
