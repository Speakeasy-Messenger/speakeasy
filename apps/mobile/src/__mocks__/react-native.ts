/**
 * Minimal react-native stub for vitest.
 * The real package uses native modules + Flow types that Rollup can't parse.
 * Only the APIs used by modules under test are stubbed here.
 */
export const Platform = { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default };

// In-memory SecureKv stub — mirrors the async-storage stub so the
// conversations store's persist / hydrate round-trips under vitest.
// Production `SecureKv` is the SQLCipher-backed native module.
const _secureKvStore = new Map<string, string>();
export const NativeModules = {
  // SpeakeasyVersion: the rc.82 native bridge. Tests that import
  // ../version get deterministic values — no hardcoded constants
  // sneak back into source via tests pinning the wrong number.
  SpeakeasyVersion: {
    versionName: '0.0.0-test',
    versionCode: 0,
  },
  SecureKv: {
    get: (key: string): Promise<string | null> =>
      Promise.resolve(_secureKvStore.get(key) ?? null),
    set: (key: string, value: string): Promise<void> => {
      _secureKvStore.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      _secureKvStore.delete(key);
      return Promise.resolve();
    },
  },
};
export const useEffect = () => {};
export const useRef = <T>(initial?: T) => ({ current: initial ?? null });
export const useState = <T>(initial: T) => [initial, () => {}];
export const Alert = { alert: () => {} };
