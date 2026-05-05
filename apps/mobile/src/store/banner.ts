import { create } from 'zustand';

/**
 * In-app foreground notification banner. Drives the `<InAppBanner>`
 * component rendered at the top of the navigator. One banner at a time
 * — `show()` replaces any in-flight banner so a flurry of inbound
 * messages doesn't queue up a 30-second backlog of toasts.
 */

export interface BannerData {
  /** Unique id — used as React key + to drive the auto-dismiss timer. */
  id: string;
  /** Sender id (adjective-adjective-noun) for direct chats. For group
   * chats this is also the sender, with `groupId` set so tap navigates
   * to the group rather than a 1:1 with the sender. */
  sender: string;
  /** Decrypted message text (truncated for display). */
  text: string;
  /** Tap target — either { kind: 'direct', peerId } or
   * { kind: 'group', groupId }. */
  target:
    | { kind: 'direct'; peerId: string }
    | { kind: 'group'; groupId: string };
}

interface BannerState {
  current: BannerData | undefined;
  show: (b: BannerData) => void;
  dismiss: () => void;
}

export const useBanner = create<BannerState>((set) => ({
  current: undefined,
  show: (b) => set({ current: b }),
  dismiss: () => set({ current: undefined }),
}));
