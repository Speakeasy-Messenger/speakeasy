import AsyncStorage from '@react-native-async-storage/async-storage';
import { diag } from '../diag/log.js';

/**
 * One-time repair for prekey bundles poisoned by the fixed-id era.
 *
 * # The damage
 *
 * Before the fresh-id fix, `generatePreKeyBundle` stored the signed prekey
 * at id 1 and one-time prekeys at ids 1..100, and the SQLCipher store used
 * INSERT OR REPLACE — so every re-enroll or replenish OVERWROTE the private
 * keys of the bundle already published to the server. The fix stops that
 * happening again, but it cannot repair a bundle that is ALREADY published
 * and already unopenable: the server keeps serving those public keys, and
 * the matching private keys are gone from the device.
 *
 * Observed 2026-08-08: @tututu's published bundle dated 2026-06-14 (signed
 * prekey id 1, 79 OTKs remaining). Every NEW peer fetching it sealed a
 * PreKey message the device could not open — "invalid PreKey message:
 * decryption failed" — for a first message AND a first call offer. 39 of 50
 * accounts on prod were in this state.
 *
 * # Why it never self-heals
 *
 * Replenish only runs on the server's `prekeys_low` signal (fewer than 10
 * OTKs left). A poisoned bundle with 79 keys left is never low, so it is
 * never rewritten — the account stays broken for first contact indefinitely.
 *
 * # The repair
 *
 * Publish a full fresh bundle once per install. Native now mints at MAX(id)+1,
 * so the old private keys stay in the store (anything already in flight to the
 * previous bundle still decrypts) while the server starts advertising keys
 * this device actually holds. Idempotent + flagged, so it costs one request
 * per upgrade, not one per launch.
 */

const FLAG_KEY = 'speakeasy.prekeys.republished.v1';

export async function republishBundleOnce(
  trigger: () => Promise<void>,
): Promise<void> {
  try {
    if (await AsyncStorage.getItem(FLAG_KEY)) return;
    diag('crypto', 'republishing prekey bundle (one-time fixed-id repair)');
    await trigger();
    await AsyncStorage.setItem(FLAG_KEY, String(Date.now()));
    diag('crypto', 'prekey bundle republished');
  } catch (err) {
    // Leave the flag unset so the next launch retries — a failed repair
    // must not be recorded as done.
    diag('crypto', 'prekey republish failed (will retry next launch)', {
      err: String(err),
    });
  }
}

/** Test seam: forget that the repair ran. */
export async function resetRepublishFlagForTests(): Promise<void> {
  await AsyncStorage.removeItem(FLAG_KEY);
}
