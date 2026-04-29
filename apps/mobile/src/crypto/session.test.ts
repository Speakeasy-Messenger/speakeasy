import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiClient, type PreKeyBundleResponse } from '../api/client.js';
import { MockSignalProtocolClient } from '../native/mock-signal-protocol.js';
import { SignalClientError } from '@speakeasy/crypto';
import { clearSessionCache, ensureSessionWithPeer } from './session.js';

/**
 * Spec coverage:
 *   - §4a / §11 Phase 5b crypto path: ensureSessionWithPeer fetches a
 *     PreKey bundle from the server on first send to a peer and calls
 *     `signalProtocol.initiateSession`. Subsequent sends in the same
 *     process must NOT refetch (one-time prekeys are server-consumed
 *     once per fetch — refetching burns a fresh OTPK from the peer's
 *     pool needlessly).
 *   - §9 error handling: ApiError on 404 (peer not enrolled),
 *     SignalClientError(`untrusted_identity`) when peer's identity key
 *     rotated and our cached session disagrees.
 *   - clearSessionCache must invalidate so re-enrollment / sign-out can
 *     force a fresh handshake.
 *
 * Strategy: stub ApiClient.fetchPreKeyBundle so we don't need a server,
 * use MockSignalProtocolClient (in-process, no native libsignal) so we
 * can spy on initiateSession. The cache is module-level state — call
 * clearSessionCache() in beforeEach so tests are isolated.
 */

function makeBundle(userId: string): PreKeyBundleResponse {
  return {
    user_id: userId,
    identity_public_key: 'BB',
    registration_id: 42,
    signed_prekey_id: 1,
    signed_prekey: 'CC',
    signed_prekey_sig: 'DD',
    one_time_prekey: { id: 7, key: 'EE' },
    remaining_prekeys: 99,
    low_water: false,
  };
}

interface Harness {
  api: { fetchPreKeyBundle: ReturnType<typeof vi.fn> };
  signalProtocol: MockSignalProtocolClient & { initiateSession: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: { bundleResult?: PreKeyBundleResponse | Error } = {}): Harness {
  const fetchPreKeyBundle = vi.fn(async (_token: string, peerUserId: string) => {
    if (opts.bundleResult instanceof Error) throw opts.bundleResult;
    return opts.bundleResult ?? makeBundle(peerUserId);
  });
  const signalProtocol = new MockSignalProtocolClient() as Harness['signalProtocol'];
  signalProtocol.initiateSession = vi.fn(signalProtocol.initiateSession.bind(signalProtocol));
  return {
    api: { fetchPreKeyBundle },
    signalProtocol,
  };
}

describe('ensureSessionWithPeer', () => {
  beforeEach(() => {
    clearSessionCache();
  });
  afterEach(() => {
    clearSessionCache();
  });

  it('fetches the peer bundle and calls initiateSession on the first call (§4a)', async () => {
    const h = makeHarness();
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    });
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(1);
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledWith('dvt_alice', 'silent-golden-hawk');
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(1);
    const [peerArg, bundleArg] = h.signalProtocol.initiateSession.mock.calls[0]!;
    expect(peerArg).toBe('silent-golden-hawk');
    // Field translation from snake_case wire → camelCase native bridge.
    expect(bundleArg).toMatchObject({
      identityPublicKey: 'BB',
      registrationId: 42,
      signedPreKeyId: 1,
      signedPreKey: 'CC',
      signedPreKeySig: 'DD',
      preKeys: [{ id: 7, key: 'EE' }],
    });
  });

  it('skips the bundle fetch on the second call for the same peer (cache prevents OTPK burn)', async () => {
    const h = makeHarness();
    const args = {
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    };
    await ensureSessionWithPeer(args);
    await ensureSessionWithPeer(args);
    await ensureSessionWithPeer(args);
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(1);
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for distinct peers (cache is per-peer)', async () => {
    const h = makeHarness();
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    });
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'planetary-timid-mire',
    });
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(2);
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(2);
  });

  it('handles bundles without a one_time_prekey (server out of OTPKs)', async () => {
    const bundle: PreKeyBundleResponse = {
      ...makeBundle('silent-golden-hawk'),
      one_time_prekey: undefined,
      remaining_prekeys: 0,
      low_water: true,
    };
    const h = makeHarness({ bundleResult: bundle });
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    });
    const [, bundleArg] = h.signalProtocol.initiateSession.mock.calls[0]!;
    expect((bundleArg as { preKeys: unknown[] }).preKeys).toEqual([]);
  });

  it('propagates ApiError(404) when the peer is not enrolled and does NOT cache (§9.1)', async () => {
    const h = makeHarness({ bundleResult: new ApiError(404, 'user_not_found') });
    await expect(
      ensureSessionWithPeer({
        api: h.api as unknown as ApiClient,
        signalProtocol: h.signalProtocol,
        deviceToken: 'dvt_alice',
        peerUserId: 'silent-golden-hawk',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(h.signalProtocol.initiateSession).not.toHaveBeenCalled();
    // Retry must re-attempt the fetch — failed fetches must not poison cache.
    h.api.fetchPreKeyBundle.mockResolvedValueOnce(makeBundle('silent-golden-hawk'));
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    });
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(2);
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(1);
  });

  it('propagates SignalClientError(untrusted_identity) and does NOT cache (§9.3)', async () => {
    const h = makeHarness();
    h.signalProtocol.initiateSession.mockRejectedValueOnce(
      new SignalClientError('untrusted_identity', 'peer key rotated'),
    );
    await expect(
      ensureSessionWithPeer({
        api: h.api as unknown as ApiClient,
        signalProtocol: h.signalProtocol,
        deviceToken: 'dvt_alice',
        peerUserId: 'silent-golden-hawk',
      }),
    ).rejects.toBeInstanceOf(SignalClientError);
    // Untrusted identity is recoverable: after the user confirms the new
    // identity (or the session store is cleared), the next call must
    // re-fetch and re-init — the cache must NOT have stuck.
    await ensureSessionWithPeer({
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    });
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(2);
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(2);
  });

  it('clearSessionCache forces a fresh handshake on the next call (sign-out / re-enrollment)', async () => {
    const h = makeHarness();
    const args = {
      api: h.api as unknown as ApiClient,
      signalProtocol: h.signalProtocol,
      deviceToken: 'dvt_alice',
      peerUserId: 'silent-golden-hawk',
    };
    await ensureSessionWithPeer(args);
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(1);

    clearSessionCache();
    await ensureSessionWithPeer(args);
    expect(h.api.fetchPreKeyBundle).toHaveBeenCalledTimes(2);
    expect(h.signalProtocol.initiateSession).toHaveBeenCalledTimes(2);
  });
});
