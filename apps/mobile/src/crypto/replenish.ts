import type { ApiClient } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';

/**
 * Refills this device's one-time prekey pool when the server pushes a
 * `prekeys_low` WS frame. Mints `batchSize` fresh OTPKs via the native
 * Signal Protocol module, uploads via `POST /v1/prekeys/replenish`.
 *
 * # Throttling
 *
 * Multiple `prekeys_low` frames can arrive in quick succession (each
 * fetcher's bundle request triggers one). We collapse concurrent calls
 * onto a single in-flight promise so back-to-back signals trigger
 * exactly one replenish round, not N.
 *
 * If the server still reports `low_water: true` after the round (the
 * batch was insufficient), one follow-up replenish is allowed. Beyond
 * that we stop and log — runaway replenishment usually means a server-side
 * counter bug, not legitimate consumption.
 *
 * # signedPreKeyId rotation
 *
 * Each replenish bumps the signed-prekey id by 1. Caller passes in the
 * id it wants to use; the next-call helper [makeReplenisher] tracks
 * monotonic incrementation across calls within a single device session.
 */
export interface ReplenishHandle {
  /** Trigger a replenish round. Concurrent calls dedupe to one round. */
  trigger(): Promise<void>;
}

interface ReplenishOpts {
  api: ApiClient;
  signalProtocol: SignalProtocolModule;
  /** Returns a fresh deviceToken (cached by Vouchflow under the hood). */
  getDeviceToken: () => Promise<string>;
  /** Default 100. */
  batchSize?: number;
  /** Initial signedPreKeyId. Bumped monotonically. Default 2 (1 used at enroll). */
  initialSignedPreKeyId?: number;
  /** Optional logger for retry / give-up cases. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function makeReplenisher(opts: ReplenishOpts): ReplenishHandle {
  const batchSize = opts.batchSize ?? 100;
  let nextSignedPreKeyId = opts.initialSignedPreKeyId ?? 2;
  let inflight: Promise<void> | undefined;

  async function runOnce(): Promise<void> {
    const token = await opts.getDeviceToken();
    const signedPreKeyId = nextSignedPreKeyId++;
    const bundle = await opts.signalProtocol.generatePreKeyBundle({
      // The native bridge ignores `registrationId` for replenish-style
      // bundles — it only matters at first enrollment — but the type
      // requires it. Pass any value; the native module uses the stored one.
      registrationId: 0,
      signedPreKeyId,
      oneTimePreKeyCount: batchSize,
    });
    const result = await opts.api.replenishPreKeys(token, {
      signedPreKeyId: bundle.signedPreKeyId,
      signedPreKey: bundle.signedPreKey,
      signedPreKeySig: bundle.signedPreKeySig,
      preKeys: bundle.preKeys,
    });
    if (result.low_water) {
      // One follow-up round, no more, to avoid runaway loops on a buggy
      // server-side counter.
      opts.log?.('prekey replenish still low_water after one round; doing one follow-up', {
        remaining: result.remaining_prekeys,
      });
      const followupId = nextSignedPreKeyId++;
      const followup = await opts.signalProtocol.generatePreKeyBundle({
        registrationId: 0,
        signedPreKeyId: followupId,
        oneTimePreKeyCount: batchSize,
      });
      const after = await opts.api.replenishPreKeys(token, {
        signedPreKeyId: followup.signedPreKeyId,
        signedPreKey: followup.signedPreKey,
        signedPreKeySig: followup.signedPreKeySig,
        preKeys: followup.preKeys,
      });
      if (after.low_water) {
        opts.log?.('prekey replenish still low_water after second round; giving up', {
          remaining: after.remaining_prekeys,
        });
      }
    }
  }

  return {
    async trigger(): Promise<void> {
      if (inflight) return inflight;
      inflight = runOnce()
        .catch((err) => {
          opts.log?.('prekey replenish failed', { err: String(err) });
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
