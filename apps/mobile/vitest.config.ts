import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Mobile tests cover framework-agnostic logic + integration scenarios.
 *
 *   - Unit tests live next to source (`src/**\/*.test.ts`).
 *   - Integration tests live under `src/integration/`. They use a
 *     two-client harness against a buildServer fixture and approximate
 *     the Hermes runtime (no Buffer global) per-test in beforeEach.
 *
 * `@react-native-async-storage/async-storage` is aliased to a tiny
 * in-memory stub for tests — the real package's lazy ESM chokes inside
 * vitest's worker, and we get an in-memory implementation for free.
 *
 * In CI (.github/workflows/release.yml) the integration suite gates the
 * release tag — no APK ships if a two-client scenario fails.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@react-native-async-storage/async-storage': path.resolve(
        __dirname,
        'src/__mocks__/async-storage.ts',
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
