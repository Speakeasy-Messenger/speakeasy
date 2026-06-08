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
   * One-shot prefill for Home's Find Someone sheet. Deep links now
   * route to AddContact directly; this remains for UI entry points
   * that already live on Home and want to pop the sheet pre-filled.
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
  /**
   * One-shot "your local store was reset on this device" banner.
   * App.tsx flips this on at startup if the native DB layer wiped
   * the encrypted store (upgrade orphan, or rare Keystore-loss
   * recovery). Dismissed via the X on the banner — does not persist
   * across launches because the native flag is one-shot too.
   */
  storeResetBannerVisible: boolean;
  showStoreResetBanner: () => void;
  dismissStoreResetBanner: () => void;
  /**
   * Privacy cover — true while the app is NOT foregrounded-active (it's
   * backgrounded / inactive / the screen just went off). Driven by the
   * App.tsx AppState listener; PrivacyCover paints an opaque sheet over
   * everything so chat content isn't visible in the app-switcher
   * thumbnail or during a screen-off→on flash. Auto-clears on 'active'
   * (no re-auth — see plan).
   */
  privacyCovered: boolean;
  setPrivacyCovered: (covered: boolean) => void;
}

export const useUiState = create<UiState>((set) => ({
  activeConversationId: undefined,
  setActiveConversation: (id) => set({ activeConversationId: id }),
  pendingFindHandle: undefined,
  setPendingFindHandle: (handle) => set({ pendingFindHandle: handle }),
  burningConversationId: undefined,
  setBurningConversationId: (id) => set({ burningConversationId: id }),
  storeResetBannerVisible: false,
  showStoreResetBanner: () => set({ storeResetBannerVisible: true }),
  dismissStoreResetBanner: () => set({ storeResetBannerVisible: false }),
  privacyCovered: false,
  setPrivacyCovered: (covered) => set({ privacyCovered: covered }),
}));
