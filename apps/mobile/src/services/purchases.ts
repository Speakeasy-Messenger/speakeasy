/**
 * AVATARSTORE.md §4 — store-purchase wrapper.
 *
 * **Phase B (this file):** Play Billing is not yet wired up, so we
 * refuse any acquisition that would grant a paid SKU. The previous
 * "fake purchase" path that resolved to ownership after a 700ms
 * delay was a real revenue bug — tapping a rare or legendary granted
 * the SKU without charging the user. The UI (AcquireSheet) now also
 * refuses to *offer* the acquisition CTA for paid avatars; this
 * function is the second line of defense in case any code path
 * (restore, debug shortcuts, future refactors) reaches it.
 *
 * **Phase C:** restore the `Purchases.purchase()` call from
 * `react-native-purchases` here. The contract this file exposes
 * (start → resolves with ownership recorded, cancelled, or failed)
 * doesn't change.
 *
 * Already-owned SKUs (the restore-flow path) still resolve as
 * `owned` so that the AcquireSheet's "Wear {name}" CTA on already-
 * acquired avatars keeps working.
 */

import { useOwnership } from '../store/ownership.js';
import { descriptorFor } from '../avatars/catalog.js';

/**
 * Master kill-switch for the paid-avatar UX. When `false`, the
 * AvatarPickerScreen hides the Rare and Legendary sections entirely
 * — users only see avatars they can actually wear (the free 12 plus
 * any paid SKUs the ownership store already has, e.g. from a future
 * restore). No "Coming soon" tiles, no price chips visible anywhere.
 *
 * Why a bare boolean instead of a config / remote flag: Phase C
 * (real Play Billing wired up) is a deliberate, app-version-tied
 * launch. The right gate is "is the next bundle's purchase code path
 * actually live" — a constant in this file, flipped in the same PR
 * that adds the real `Purchases.purchase()` call. Remote toggling
 * would risk surfacing the price UX with no working buy button when
 * the toggle and the code diverge in versions.
 */
export const PURCHASING_LIVE = false;

export type PurchaseOutcome =
  | { kind: 'owned'; skuId: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

/**
 * Initiate a purchase for a paid avatar.
 *
 * Until Phase C wires up real Play Billing / StoreKit, this returns
 * `{ kind: 'failed', reason: 'not_yet_available' }` for any SKU the
 * caller does not already own. Already-owned SKUs (the restore
 * flow) resolve to `owned` idempotently.
 */
export async function purchaseAvatar(animalId: string): Promise<PurchaseOutcome> {
  const desc = descriptorFor(animalId);
  if (!desc?.skuId) {
    return { kind: 'failed', reason: 'no_sku_for_id' };
  }
  if (useOwnership.getState().hasOwnership(desc.skuId)) {
    // Already owned — idempotent path. Keeps the AcquireSheet's
    // "Wear {name}" CTA working for already-acquired avatars.
    return { kind: 'owned', skuId: desc.skuId };
  }
  // Phase C TODO: replace with `Purchases.purchase(...)` from
  // react-native-purchases. Until then we explicitly refuse — the
  // previous fake-success path silently granted SKUs and was a real
  // revenue bug.
  return { kind: 'failed', reason: 'not_yet_available' };
}
