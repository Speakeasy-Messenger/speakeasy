/**
 * Build-time config.
 *
 * Defaults below match the alpha sandbox server. CI's tier-b-emulator
 * workflow swaps the file via `scripts/write-test-config.mjs` BEFORE
 * `assembleRelease` so the in-CI emulator points at the api server
 * running on the same runner (10.0.2.2 = the host loopback from inside
 * the Android emulator).
 *
 * For production / local dev, leave alone.
 */
export const config = {
  /** Speakeasy API base URL. */
  apiBaseUrl: 'http://65.21.224.209:8080',
  /** WebSocket URL. */
  wsUrl: 'ws://65.21.224.209:8080/ws',
  /**
   * If true, services use MockVouchflowClient instead of the real native
   * bridge. Useful for QA harnesses, Storybook, or simulators that can't
   * run App Attest / Play Integrity. Always false in shipped builds.
   */
  useMockVouchflow: false,
  /**
   * If true, services use MockSignalProtocolClient. Same use cases as the
   * Vouchflow mock. Always false in shipped builds.
   */
  useMockSignalProtocol: false,
};
