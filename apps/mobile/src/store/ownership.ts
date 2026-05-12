import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Ownership of paid avatars. Backed by AsyncStorage so a sideloaded
 * alpha persists across cold starts; backed by RevenueCat in prod
 * (Phase C — see AVATARSTORE.md §4).
 *
 * In Phase A this is the source of truth for "is this SKU owned" —
 * the picker dims locked tiles, the AcquireSheet flips ownership on
 * the fake purchase tap, and the renderer doesn't care (anyone can
 * select any owned id; rendering doesn't gate on ownership).
 *
 * Cross-device sync (§4.3) is a Phase C concern; until then the
 * device + the install are the same scope.
 */

const STORAGE_KEY = 'speakeasy.ownership.v1';

interface OwnershipState {
  /** SKU id → true. Lookup-stable; replace by reference on writes
   * so Zustand selector consumers see a real change. */
  ownedSkus: Record<string, true>;
  hydrated: boolean;
  /** Last attempted restore. Used by the picker / acquire sheet to
   * gate the "Restore purchases" UI affordance — null = never tried. */
  lastRestoreAt: number | null;
  hydrate: () => Promise<void>;
  /** Mark a SKU as owned. Idempotent; safe to call from both the
   * fake purchase flow and the future RevenueCat callback. */
  markOwned: (skuId: string) => void;
  /** Convenience predicate. */
  hasOwnership: (skuId: string) => boolean;
  /**
   * Stub. In Phase C this calls `Purchases.restorePurchases()` and
   * folds the resulting entitlement set into `ownedSkus`. Today it
   * just stamps `lastRestoreAt`.
   */
  restore: () => Promise<void>;
  /**
   * Test / debug only. Clears ownership; used by the diagnostics
   * "wipe avatar entitlements" affordance and by `_enroll-with-handle`
   * cleanup in tier B flows.
   */
  reset: () => Promise<void>;
}

async function persist(ownedSkus: Record<string, true>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ownedSkus));
  } catch {
    /* best-effort; the in-memory state is the working source of truth */
  }
}

export const useOwnership = create<OwnershipState>((set, get) => ({
  ownedSkus: {},
  hydrated: false,
  lastRestoreAt: null,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, true>;
        set({ ownedSkus: parsed });
      }
    } catch {
      /* corrupt / missing → empty */
    } finally {
      set({ hydrated: true });
    }
  },

  markOwned: (skuId) => {
    if (get().ownedSkus[skuId]) return;
    const next = { ...get().ownedSkus, [skuId]: true as const };
    set({ ownedSkus: next });
    void persist(next);
  },

  hasOwnership: (skuId) => Boolean(get().ownedSkus[skuId]),

  restore: async () => {
    set({ lastRestoreAt: Date.now() });
    /* Phase C: hand off to Purchases SDK and fold result */
  },

  reset: async () => {
    set({ ownedSkus: {}, lastRestoreAt: null });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
