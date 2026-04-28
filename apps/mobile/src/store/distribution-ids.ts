import { create } from 'zustand';

/**
 * Per-group SenderKey distributionId allocator. Each (local-sender, group)
 * has one UUID v4; allocated lazily on first send to the group.
 *
 * # Persistence
 *
 * In-memory only for the moment. A cold start re-allocates new UUIDs,
 * which forces a one-time SKDM re-fan-out per group — wasteful but
 * correct. Moves to SQLCipher when conversation persistence lands
 * (Phase 5e), at which point the same UUID survives reboots and the
 * SKDM is sent exactly once per (sender, group) lifetime.
 */
export interface DistributionIdsState {
  byGroup: Record<string, string>;
  getOrCreate: (groupId: string) => string;
  reset: () => void;
}

function uuidv4(): string {
  // Standard RFC 4122 v4 UUID via crypto.getRandomValues. RN polyfills
  // crypto in Hermes 0.76+; fallback to Math.random for non-crypto hosts
  // (vitest with jsdom-like setups) where it doesn't exist yet.
  const c = (globalThis as { crypto?: { getRandomValues?: (buf: Uint8Array) => Uint8Array } }).crypto;
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const useDistributionIds = create<DistributionIdsState>((set, get) => ({
  byGroup: {},
  getOrCreate: (groupId: string) => {
    const existing = get().byGroup[groupId];
    if (existing) return existing;
    const fresh = uuidv4();
    set((s) => ({ byGroup: { ...s.byGroup, [groupId]: fresh } }));
    return fresh;
  },
  reset: () => set({ byGroup: {} }),
}));
