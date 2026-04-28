/**
 * Build-time config. In a real app these come from env / a config plugin.
 *
 * Alpha (Phase 5e): pointed at the dev sandbox server on the Linux box's
 * public IP. Will move to `https://sandbox.api.speakeasyapp.xyz` once
 * Fly + DNS are up.
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
