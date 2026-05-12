/**
 * AVATARSTORE.md §4 — store-purchase wrapper.
 *
 * Phase A (this file): fake purchase that simulates the StoreKit /
 * Play Billing modal with a 700ms delay and resolves to ownership
 * flip. Lets the picker / acquire sheet UX get exercised end-to-end
 * before native build access.
 *
 * Phase C: replace `purchaseAvatar` with a real `Purchases.purchase()`
 * call from `react-native-purchases`. The contract this file exposes
 * (start → resolves with ownership recorded) doesn't change.
 */

import { useOwnership } from '../store/ownership.js';
import { descriptorFor } from '../avatars/catalog.js';

export type PurchaseOutcome =
  | { kind: 'owned'; skuId: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

/**
 * Initiate a purchase for a paid avatar. The caller (AcquireSheet)
 * shows a spinner until this resolves. Phase A always succeeds after
 * a fixed delay; Phase C will surface real cancel / fail outcomes
 * from the platform store.
 */
export async function purchaseAvatar(animalId: string): Promise<PurchaseOutcome> {
  const desc = descriptorFor(animalId);
  if (!desc?.skuId) {
    return { kind: 'failed', reason: 'no_sku_for_id' };
  }
  if (useOwnership.getState().hasOwnership(desc.skuId)) {
    // Already owned — idempotent path. Used by Phase C when the
    // restore flow runs concurrently with a tap; harmless today.
    return { kind: 'owned', skuId: desc.skuId };
  }
  await new Promise<void>((r) => setTimeout(r, 700));
  useOwnership.getState().markOwned(desc.skuId);
  return { kind: 'owned', skuId: desc.skuId };
}
