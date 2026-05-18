import { create } from 'zustand';

/**
 * Tiny transient confirmation toast (e.g. "Copied").
 *
 * Cross-platform: Android's `ToastAndroid` has no iOS equivalent, so
 * the app renders its own toast — the `<Toast>` component mounted in
 * App.tsx. One message at a time; `show()` replaces any in-flight
 * toast. `nonce` bumps on every `show()` so re-showing the same text
 * re-triggers the animation.
 */
interface ToastState {
  message: string | undefined;
  nonce: number;
  show: (message: string) => void;
  clear: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: undefined,
  nonce: 0,
  show: (message) => set((s) => ({ message, nonce: s.nonce + 1 })),
  clear: () => set({ message: undefined }),
}));
