import { create } from 'zustand';

/**
 * Holds text shared INTO Speakeasy from another app's share sheet, until the
 * user picks a conversation to drop it into. Flow:
 *   1. Native (SpeakeasyShare) captures the ACTION_SEND text.
 *   2. App.tsx drains it on AppState 'active' → setPendingText + go to the
 *      conversation list, which shows a "pick a chat to share into" banner.
 *   3. The first chat/group opened calls take() — prefilling its composer
 *      with the shared text and clearing the pending state (one-shot).
 */
interface ShareState {
  pendingText: string | null;
  setPendingText: (text: string | null) => void;
  /** Return the pending shared text and clear it. One-shot. */
  take: () => string | null;
}

export const useShare = create<ShareState>((set, get) => ({
  pendingText: null,
  setPendingText: (text) => set({ pendingText: text }),
  take: () => {
    const t = get().pendingText;
    if (t !== null) set({ pendingText: null });
    return t;
  },
}));
