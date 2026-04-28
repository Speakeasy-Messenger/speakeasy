import { defineConfig } from 'vitest/config';

/**
 * Tests cover framework-agnostic logic only (api client, ws client, stores,
 * helpers). RN component rendering is not tested in this config — see README.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
