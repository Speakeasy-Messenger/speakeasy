/**
 * In-memory AsyncStorage stub for vitest (Node has no native AsyncStorage,
 * and the real package's ESM resolution chokes inside vitest's worker).
 * Tests that exercise identity persistence drive this stub directly via
 * the exported helpers; other tests get a working get/set/remove without
 * caring.
 *
 * Aliased into the bundle by vitest.config.ts → `resolve.alias`.
 */
const memory = new Map<string, string>();

const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => memory.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    memory.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    memory.delete(key);
  },
  multiGet: async (keys: string[]): Promise<Array<[string, string | null]>> =>
    keys.map((k) => [k, memory.get(k) ?? null]),
  multiSet: async (pairs: Array<[string, string]>): Promise<void> => {
    for (const [k, v] of pairs) memory.set(k, v);
  },
  multiRemove: async (keys: string[]): Promise<void> => {
    for (const k of keys) memory.delete(k);
  },
  getAllKeys: async (): Promise<readonly string[]> => Array.from(memory.keys()),
  clear: async (): Promise<void> => {
    memory.clear();
  },
};

export default AsyncStorage;

/** Test-only helper to wipe the in-memory map between cases. */
export function __resetAsyncStorageMock(): void {
  memory.clear();
}
