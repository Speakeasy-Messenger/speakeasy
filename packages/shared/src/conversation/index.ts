import { createHash } from 'node:crypto';
import { isCommunityId, isGroupId, isUserId } from '../ids/index.js';

/**
 * Deterministic conversation identifier per spec §8 (the `messages.conversation`
 * column). Encodes the conversation kind in the prefix so logs / queries
 * can filter without lookups.
 *
 *   1:1     →  dm-<sha256(sortedPair).slice(0, 16)>
 *   group   →  the grp-… id passes through
 *   community → the com-… id passes through
 *
 * Sorting in 1:1 means alice↔bob and bob↔alice produce the same id.
 */

export function conversationIdForDirect(a: string, b: string): string {
  if (a === b) throw new Error('conversationIdForDirect: cannot DM yourself');
  if (!isUserId(a) || !isUserId(b)) {
    throw new Error('conversationIdForDirect: both ids must be user ids');
  }
  const [first, second] = a < b ? [a, b] : [b, a];
  const hash = createHash('sha256').update(`${first}:${second}`).digest('hex');
  return `dm-${hash.slice(0, 16)}`;
}

export function conversationIdForGroup(groupId: string): string {
  if (!isGroupId(groupId)) {
    throw new Error('conversationIdForGroup: not a group id');
  }
  return groupId;
}

export function conversationIdForCommunity(communityId: string): string {
  if (!isCommunityId(communityId)) {
    throw new Error('conversationIdForCommunity: not a community id');
  }
  return communityId;
}

export function isDirectConversationId(id: string): boolean {
  return /^dm-[0-9a-f]{16}$/.test(id);
}
