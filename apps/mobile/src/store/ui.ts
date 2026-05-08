import { create } from 'zustand';

/**
 * Transient UI state that doesn't belong on disk.
 *
 * `activeConversationId` is set by ChatScreen / GroupChatScreen on mount
 * and cleared on unmount. Used to suppress the in-app message banner
 * when the user is already staring at the relevant chat.
 */
interface UiState {
  activeConversationId: string | undefined;
  setActiveConversation: (id: string | undefined) => void;
  /**
   * Inbound `speakeasy://add?handle=<h>` deep links land here so
   * the conversation list can pop the Find Someone sheet pre-
   * filled when it next mounts. Cleared by the consumer.
   */
  pendingFindHandle: string | undefined;
  setPendingFindHandle: (handle: string | undefined) => void;
  /**
   * BURN.md §5 — transient flag that drives the dissolve animation.
   * When set: ChatScreen runs the feed-fade, ConversationsScreen
   * runs the row-collapse, and the conversation is removed when
   * both finish. Cleared by the row-collapse completion handler.
   */
  burningConversationId: string | undefined;
  setBurningConversationId: (id: string | undefined) => void;
}

export const useUiState = create<UiState>((set) => ({
  activeConversationId: undefined,
  setActiveConversation: (id) => set({ activeConversationId: id }),
  pendingFindHandle: undefined,
  setPendingFindHandle: (handle) => set({ pendingFindHandle: handle }),
  burningConversationId: undefined,
  setBurningConversationId: (id) => set({ burningConversationId: id }),
}));
