import { create } from 'zustand';

export interface IdentityState {
  userId: string | undefined;
  /**
   * Vouchflow deviceToken minted at signup. Reused for every authenticated
   * call (WS auth, prekey bundle fetch) so we don't re-prompt biometric
   * or re-attest on every action. Real Vouchflow rotates the token
   * server-side under the hood and the SDK reads the latest from
   * AccountManager; LocalDevValidator never rotates.
   * Cleared by `reset()` (sign out).
   */
  deviceToken: string | undefined;
  setUserId: (id: string | undefined) => void;
  setDeviceToken: (token: string | undefined) => void;
  reset: () => void;
}

export const useIdentity = create<IdentityState>((set) => ({
  userId: undefined,
  deviceToken: undefined,
  setUserId: (userId) => set({ userId }),
  setDeviceToken: (deviceToken) => set({ deviceToken }),
  reset: () => set({ userId: undefined, deviceToken: undefined }),
}));

export const isEnrolled = (s: IdentityState): boolean => Boolean(s.userId);
