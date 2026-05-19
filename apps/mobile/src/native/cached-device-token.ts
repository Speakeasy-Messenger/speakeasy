/**
 * Single JS reader for the Vouchflow device token.
 *
 * The device token is a bearer-like credential: it authenticates every
 * API / WebSocket request and seeds the SQLCipher database key. It is
 * owned by the Vouchflow SDK, which persists it in native secure storage
 * (Android `AccountManager`, iOS Keychain). The JS layer must NOT keep a
 * second copy in AsyncStorage — that store is an unencrypted on-disk
 * SQLite file and broadens the credential's attack surface.
 *
 * `NativeModules.Vouchflow.getCachedDeviceToken()` reads that native copy
 * with no biometric prompt and no network call, so it is safe to call in
 * any context — app launch, request paths, and the headless push handler.
 *
 * The `react-native` require is wrapped: in Node test environments the
 * native module is absent, and callers treat `undefined` as "not
 * enrolled" / "not available" and fall back accordingly.
 */
export async function getCachedDeviceToken(): Promise<string | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native') as {
      NativeModules?: Record<string, { getCachedDeviceToken?: () => Promise<string | null> }>;
    };
    const mod = rn.NativeModules?.Vouchflow;
    if (!mod?.getCachedDeviceToken) return undefined;
    const token = await mod.getCachedDeviceToken();
    return token ?? undefined;
  } catch {
    return undefined;
  }
}
