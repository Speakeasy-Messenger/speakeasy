import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SpeakeasyWsClient } from '../ws/client.js';
import { useIdentity } from '../store/identity.js';
import { useVerifySheet } from '../store/verify-sheet.js';
import { verifyDeviceWithExplanation } from './verify-device.js';
import type { VerifyResult, VouchflowClient } from '../native/vouchflow.js';

/**
 * Reproduction of the September 2026 Android lockout (`lake-late-trout`).
 *
 * The device's last Vouchflow verification aged past the server's 30-day
 * freshness window, so WS auth closed 4004 `stale_verification` — correct
 * server behaviour. The client correctly decided to re-verify. The bug is
 * what happened next: the forced re-verification never reached the native
 * Vouchflow SDK, so no new verification was ever created, the same stale
 * credential was re-presented, and the rejection repeated forever.
 *
 * The test drives the real composition end to end: the real
 * `SpeakeasyWsClient` reconnect ladder, the real `App.tsx`-shaped
 * `getToken({forceRefresh})`, the real `verifyDeviceWithExplanation`
 * sheet flow, and a stub standing in for the native SDK that counts how
 * many verifications it was asked to create.
 */

/**
 * The app's Vouchflow wiring, mirroring `services.ts`: the SDK client
 * with nothing in front of it. `native/vouchflow-wiring.test.ts` pins
 * `services.ts` to this same shape, so a wrapper reintroduced there
 * fails there rather than silently diverging from this test.
 */
function buildAppVouchflowClient(sdk: VouchflowClient): VouchflowClient {
  return sdk;
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly url: string;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly sent: string[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: any) => void) {
    (this.listeners[name] ??= []).push(cb);
  }
  removeEventListener() {
    /* unused */
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = this.CLOSED;
    this.fire('close', { code, reason });
  }
  fire(name: string, ev: any) {
    for (const cb of this.listeners[name] ?? []) cb(ev);
  }
  open() {
    this.readyState = this.OPEN;
    this.fire('open', {});
  }
  message(payload: unknown) {
    this.fire('message', { data: JSON.stringify(payload) });
  }
  /** The token this socket presented in its `auth` frame. */
  presentedToken(): string | undefined {
    const frame = this.sent[0];
    return frame ? (JSON.parse(frame) as { token: string }).token : undefined;
  }
}

/**
 * Stands in for the native Vouchflow SDK. Every `verify()` is one real
 * verification created against Vouchflow, so `attempts` is the count of
 * rows the incident found to be zero.
 */
function nativeSdkStub(): VouchflowClient & { attempts: number } {
  const stub = {
    attempts: 0,
    async verify(): Promise<VerifyResult> {
      stub.attempts++;
      return {
        verified: true,
        confidence: 'low',
        deviceToken: `dvt_${stub.attempts}`,
        deviceAgeDays: 400,
        networkVerifications: stub.attempts,
        firstSeen: '2025-08-01T00:00:00Z',
        context: 'login',
        fallbackUsed: false,
        signals: {
          biometricUsed: true,
          attestationVerified: true,
          persistentToken: true,
          crossAppHistory: false,
          anomalyFlags: [],
        },
      };
    },
    async requestFallback() {
      throw new Error('not reached');
    },
    async submitFallbackOtp() {
      throw new Error('not reached');
    },
    async getCachedDeviceToken() {
      return null;
    },
  } as unknown as VouchflowClient & { attempts: number };
  return stub;
}

/** The user tapping Continue on the verify sheet as soon as it appears. */
function autoTapContinue(): () => void {
  return useVerifySheet.subscribe((s) => {
    if (s.pending && !s.verificationInFlight && !s.fallback) {
      void Promise.resolve().then(() => useVerifySheet.getState().confirm());
    }
  });
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
  useIdentity.setState({
    userId: 'lake-late-trout',
    deviceToken: undefined,
    deviceTokenIssuedAt: undefined,
    hydrated: true,
  });
  useVerifySheet.setState({
    pending: undefined,
    fallback: undefined,
    verificationInFlight: false,
    nonce: 0,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('stale-verification recovery', () => {
  it('reaches the native SDK on a forced refresh, so the stale credential is replaced', async () => {
    const sdk = nativeSdkStub();
    const vouchflow = buildAppVouchflowClient(sdk);
    const stopTapping = autoTapContinue();

    // An earlier verification in this process (onboarding / launch
    // refresh) already produced a credential. That credential is what
    // later goes stale.
    const first = await vouchflow.verify({ context: 'login', minimumConfidence: 'low' });
    useIdentity.getState().setDeviceToken(first.deviceToken);
    expect(sdk.attempts).toBe(1);

    // App.tsx's `getToken`, verbatim in shape.
    const getToken = async (opts?: { forceRefresh?: boolean }) => {
      const cached = useIdentity.getState().deviceToken;
      if (cached && !opts?.forceRefresh) return cached;
      const r = await verifyDeviceWithExplanation(
        vouchflow,
        opts?.forceRefresh ? 'websocket_auth_failed' : 'missing_token',
      );
      return r.deviceToken;
    };

    const ws = new SpeakeasyWsClient({
      url: 'ws://speakeasy.test/ws',
      getToken,
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      reconnectBaseMs: 100,
      maxReconnectMs: 1000,
      pingIntervalMs: 10_000,
    });

    ws.connect();
    const stale = FakeSocket.instances[0]!;
    stale.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.presentedToken()).toBe('dvt_1');

    // The server's freshness check rejects it — correct behaviour, and
    // not what this test is about.
    stale.close(4004, 'stale_verification');
    expect(ws.getState()).toBe('reconnecting');

    // The reconnect ladder forces a re-attestation before it opens the
    // replacement socket.
    await vi.advanceTimersByTimeAsync(200);

    // THE BUG THIS PINS: a client that can answer verify() from cache
    // never calls the SDK, so Vouchflow records no new verification and
    // the same rejected credential is handed straight back — which is
    // how the loop became permanent.
    expect(sdk.attempts).toBe(2);

    const replacement = FakeSocket.instances[1]!;
    replacement.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.presentedToken()).toBe('dvt_2');

    replacement.message({ type: 'authed', user_id: 'lake-late-trout' });
    expect(ws.getState()).toBe('authed');
    expect(useIdentity.getState().deviceToken).toBe('dvt_2');

    stopTapping();
    ws.close();
  });
});
