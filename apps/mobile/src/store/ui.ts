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
}

export const useUiState = create<UiState>((set) => ({
  activeConversationId: undefined,
  setActiveConversation: (id) => set({ activeConversationId: id }),
}));
