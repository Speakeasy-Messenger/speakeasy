import { NativeModules } from 'react-native';

/**
 * Encrypted key-value store, backed by the `kv` table in the SQLCipher
 * `SpeakeasyDb` via the native `SecureKv` module.
 *
 * Why it exists: decrypted conversation history used to be persisted to
 * AsyncStorage, which on Android is an unencrypted SQLite file. The
 * Signal keys already live in the SQLCipher DB; the decrypted message
 * bodies belong in the same encrypted store. `store/conversations.ts`
 * persists through this instead.
 *
 * Failure modes the caller must tolerate:
 *  - the native module is absent (JS-only test runs);
 *  - the DB hasn't been opened yet (its passphrase is HKDF-derived from
 *    the Vouchflow device token, which doesn't exist before enrollment).
 * Both surface as a rejected promise; callers treat that as "nothing
 * persisted" and fall back to in-memory state — conversations only
 * exist post-enrollment anyway.
 *
 * Eager top-level `import { NativeModules } from 'react-native'` is
 * load-bearing: vitest aliases `react-native` to the mock, NativeModules
 * is read at module-load time, and the mock's `_secureKvStore` Map
 * stays a single instance across imports. Lazy require / dynamic
 * import split the test harness's mock from this module's reference
 * (different module-cache lookups in vitest's worker), so persist
 * writes to one Map and hydrate reads from a different one.
 */
interface NativeSecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const native = (NativeModules as { SecureKv?: NativeSecureKv }).SecureKv;

function mod(): NativeSecureKv {
  if (!native) throw new Error('SecureKv native module unavailable');
  return native;
}

export const secureKv = {
  get: (key: string): Promise<string | null> => mod().get(key),
  set: (key: string, value: string): Promise<void> => mod().set(key, value),
  delete: (key: string): Promise<void> => mod().delete(key),
};
