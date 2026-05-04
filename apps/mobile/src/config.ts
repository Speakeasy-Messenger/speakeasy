/**
 * Build-time config. In a real app these come from env / a config plugin.
 *
 * Alpha (Phase 5e): pointed at the dev sandbox server on the Linux box's
 * public IP. Will move to `https://sandbox.api.speakeasyapp.xyz` once
 * Fly + DNS are up.
 *
 * WARNING: scripts/write-test-config.mjs OVERWRITES this file during
 * Tier B CI to point at the in-runner api server (10.0.2.2). DO NOT
 * commit that overwrite — every non-CI build picks up whatever's in
 * here, and 10.0.2.2 is unreachable from real devices ("TypeError:
 * Network request failed"). Run `git checkout apps/mobile/src/config.ts`
 * after Tier B to restore these values before committing.
 */
export const config = {
  /** Speakeasy API base URL. */
  apiBaseUrl: 'http://65.21.224.209:8080',
  /** WebSocket URL. */
  wsUrl: 'ws://65.21.224.209:8080/ws',
  /**
   * If true, services use MockSignalProtocolClient instead of the real
   * native bridge. Useful for QA harnesses, Storybook, or simulators that
   * can't run libsignal natively. Always false in shipped builds.
   */
  useMockSignalProtocol: false,
};
