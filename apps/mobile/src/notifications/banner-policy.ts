import {
  conversationIdForDirect,
  conversationIdForGroup,
} from '@speakeasy/shared';
import type { BannerData } from '../store/banner.js';
import type { ActiveCall } from '../calls/types.js';

/**
 * Pure decision logic for whether an inbound message produces an
 * in-app banner. Lives outside `App.tsx` so unit tests can exercise
 * each branch deterministically without spinning up a navigator.
 *
 * Branches in order (first match wins):
 *   - `disabled` — global toggle off (Settings → Notifications →
 *     Banner when in another conversation)
 *   - `active-conv` — user is currently on the target conversation
 *     screen; the message is already visible in the feed
 *   - `muted` — per-conversation mute is on
 *   - `in-call` — user is on a call; banners wait until it ends
 *   - `show` — fire it
 */

export interface BannerPolicyInputs {
  myUserId: string;
  inboundFrom: string;
  inboundText: string;
  inboundTarget: BannerData['target'];
  /** Result of `useSettings.getState().inAppNotificationsEnabled`. */
  inAppNotificationsEnabled: boolean;
  /** Result of `useUiState.getState().activeConversationId`. */
  activeConversationId: string | undefined;
  /** Lookup against `useConversations.getState().byId[id]?.muted`. */
  isMuted: (conversationId: string) => boolean;
  /** Result of `useCalls.getState().active`. */
  activeCall: ActiveCall | undefined;
}

export type BannerDecision =
  | { kind: 'show'; banner: BannerData }
  | { kind: 'disabled' }
  | { kind: 'active-conv' }
  | { kind: 'muted' }
  | { kind: 'in-call' };

export function decideBanner(
  inputs: BannerPolicyInputs,
  msgId: string,
): BannerDecision {
  if (!inputs.inAppNotificationsEnabled) return { kind: 'disabled' };

  const targetConv =
    inputs.inboundTarget.kind === 'direct'
      ? conversationIdForDirect(inputs.myUserId, inputs.inboundTarget.peerId)
      : conversationIdForGroup(inputs.inboundTarget.groupId);

  if (inputs.activeConversationId === targetConv) {
    return { kind: 'active-conv' };
  }
  if (inputs.isMuted(targetConv)) return { kind: 'muted' };

  const call = inputs.activeCall;
  if (call && call.stage !== 'ended') return { kind: 'in-call' };

  return {
    kind: 'show',
    banner: {
      id: msgId,
      sender: inputs.inboundFrom,
      text: inputs.inboundText,
      target: inputs.inboundTarget,
    },
  };
}
