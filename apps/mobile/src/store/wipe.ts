import AsyncStorage from '@react-native-async-storage/async-storage';
import { diag } from '../diag/log.js';

/**
 * Wipe every persisted Speakeasy store from AsyncStorage.
 *
 * The bug this fixes (rc.80 ghost-identity): on Android, AsyncStorage
 * lives in `databases/RKStorage` which by default rides Google's
 * Auto Backup → Drive. The Vouchflow attestation files were
 * explicitly excluded for security, but AsyncStorage wasn't — so a
 * user who reinstalled the app on the same Google account got back
 * their old userId + conversation list (from AsyncStorage) but a
 * FRESH Vouchflow deviceToken (from a re-attest). The SQLCipher key
 * derives from the deviceToken, so `signalProtocol.generateIdentityKey`
 * failed to open the keystore, biometric prompt failed, identity got
 * cleared via `useIdentity.reset()` — but every other persisted
 * store (conversations, profiles, groups, …) survived because each
 * one is a separate AsyncStorage key with its own lifecycle.
 *
 * Concrete user-facing symptom: tester9 reinstalls → onboards as
 * tester13 → still sees tester9's chats with @lunchbox8.
 *
 * The XML-level fix (data_extraction_rules.xml) excludes RKStorage
 * from future backups. This function heals the existing-user case:
 * call it whenever we detect the corrupted-state path so the device
 * is clean before re-onboarding.
 *
 * Keys are not statically enumerated — we scan AsyncStorage and
 * filter for the `speakeasy` prefix (every store either uses
 * `speakeasy.*.v*` or the legacy `speakeasy-*`). Future stores
 * inherit the wipe for free as long as they follow the convention.
 *
 * Not wiped (out of scope):
 *   - The SQLCipher `speakeasy.db` (lives in `databases/`, not
 *     AsyncStorage). Cleared via the native module's own reset path.
 *   - SharedPreferences (Vouchflow attestation, theme native cache).
 *     These don't carry per-user state.
 */
export async function wipeAllPersistedState(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter(
      (k) => k.startsWith('speakeasy.') || k.startsWith('speakeasy-'),
    );
    if (ours.length === 0) {
      diag('app', 'wipeAllPersistedState: nothing to wipe');
      return;
    }
    await AsyncStorage.multiRemove(ours);
    diag('app', 'wipeAllPersistedState: wiped', { count: ours.length, keys: ours });
  } catch (err) {
    // Non-fatal — the caller will still call useIdentity.reset() and
    // the user will land on Onboarding; the worst case is the same
    // ghost-state we're trying to clear lingers in memory until the
    // next process restart, which itself does a fresh hydrate of
    // AsyncStorage (now containing nothing for us thanks to the
    // partial removeItem progress, or still containing the old data
    // if we totally failed — either way, no regression vs. status quo).
    diag('app', 'wipeAllPersistedState: failed', { err: String(err) });
  }
}
