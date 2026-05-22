import type { ConversationState } from '../store/conversations.js';

interface ConversationSnapshot {
  hydrated: boolean;
  byId: Record<string, ConversationState>;
}

/**
 * Background push display may run in a headless JS process. Only suppress
 * when the encrypted conversation store has hydrated and explicitly says
 * the target is muted; an unhydrated store should not drop notifications.
 */
export function shouldSuppressPushForMute(
  conversationId: string | undefined,
  conversations: ConversationSnapshot,
): boolean {
  if (!conversationId || !conversations.hydrated) return false;
  return conversations.byId[conversationId]?.muted === true;
}
