import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Per-group SenderKey distributionId allocator. Each (local-sender, group)
 * has one UUID v4; allocated lazily on first send to the group.
 *
 * Persisted to AsyncStorage so distribution IDs survive app restarts.
 * This avoids unnecessary SKDM re-fan-out per group after a cold start.
 */

const STORAGE_KEY = 'speakeasy-distribution-ids';

export interface DistributionIdsState {
  byGroup: Record<string, string>;
  /** True once `hydrate()` has run (loaded from disk on startup). */
  hydrated: boolean;
  getOrCreate: (groupId: string) => string;
  /** Read persisted state from disk. Idempotent. */
  hydrate: () => Promise<void>;
  /** Wipe distribution IDs locally AND on disk. */
  reset: () => Promise<void>;
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

async function persist(byGroup: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byGroup));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the source
    // of truth for the current session.
  }
}

export const useDistributionIds = create<DistributionIdsState>((set, get) => ({
  byGroup: {},
  hydrated: false,

  getOrCreate: (groupId: string) => {
    const existing = get().byGroup[groupId];
    if (existing) return existing;
    const fresh = uuidv4();
    const newByGroup = { ...get().byGroup, [groupId]: fresh };
    set({ byGroup: newByGroup });
    void persist(newByGroup);
    return fresh;
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        set({ byGroup: parsed });
      }
    } catch {
      // Corrupt / missing → keep empty state.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ byGroup: {}, hydrated: false });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
