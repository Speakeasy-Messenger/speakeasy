import { create } from 'zustand';

export interface IdentityState {
  userId: string | undefined;
  setUserId: (id: string | undefined) => void;
  reset: () => void;
}

export const useIdentity = create<IdentityState>((set) => ({
  userId: undefined,
  setUserId: (userId) => set({ userId }),
  reset: () => set({ userId: undefined }),
}));

export const isEnrolled = (s: IdentityState): boolean => Boolean(s.userId);
