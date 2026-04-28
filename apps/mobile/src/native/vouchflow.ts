import type { Confidence, VerificationContext } from '@speakeasy/vouchflow';

/**
 * Mobile-side Vouchflow client. Mirrors the iOS / Android SDK signature:
 *
 *   iOS    — Vouchflow.shared.verify(context: .signup) → VouchflowResult
 *   Android — Vouchflow.shared.verify(activity, VerificationContext.SIGNUP) → VouchflowResult
 *
 * The SDK does enrollment + challenge + sign + Vouchflow API call internally.
 * What lands in JS is the result `{verified, confidence, deviceToken, signals}`.
 * Forward `deviceToken` to the Speakeasy server which validates it via
 * `GET /v1/device/{deviceToken}/reputation` (read-scoped key, server-side).
 *
 * Note: `currentConfidence()` was removed in the April 2026 SDK revision —
 * confidence is checked inline by passing `minimumConfidence` to `verify()`,
 * which throws `MinimumConfidenceUnmet` rather than returning a low result.
 */

export interface VouchflowSignals {
  biometricUsed: boolean;
  attestationVerified: boolean;
  /** SDK April 2026 revision: renamed from `keychainPersistent`. */
  persistentToken: boolean;
  crossAppHistory: boolean;
  anomalyFlags: string[];
}

export interface VerifyResult {
  verified: boolean;
  confidence: Confidence;
  deviceToken: string;
  signals: VouchflowSignals;
  fallbackUsed: boolean;
}

export interface VerifyOpts {
  context: VerificationContext;
  /** SDK throws `MinimumConfidenceUnmet` if the device can't reach this. */
  minimumConfidence?: Confidence;
}

export interface VouchflowClient {
  /** Full attestation flow. Returns the `deviceToken` to pass to your server. */
  verify(opts: VerifyOpts): Promise<VerifyResult>;
}

/** Mirrors the Kotlin `VouchflowError` sealed class (April 2026 revision). */
export type VouchflowErrorReason =
  | 'biometric_cancelled'
  | 'biometric_failed'
  | 'biometric_unavailable'
  | 'minimum_confidence_unmet'
  | 'network_unavailable'
  | 'enrollment_failed'
  | 'no_activity'
  | 'bad_context'
  | 'bad_confidence'
  | 'unknown_error';

export class VouchflowClientError extends Error {
  constructor(public readonly reason: VouchflowErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'VouchflowClientError';
  }
}

interface NativeVouchflowModule {
  verify(
    context: string,
    minimumConfidence: string | null,
  ): Promise<{
    verified: boolean;
    confidence: 'high' | 'medium' | 'low';
    deviceToken: string;
    fallbackUsed: boolean;
    signals: VouchflowSignals;
  }>;
}

/**
 * Conditional require of `react-native`. In RN production bundles the module
 * is provided globally by Metro. In Node test envs (vitest) the require
 * throws — callers should use `MockVouchflowClient` for tests, never this
 * class directly.
 */
function loadNativeModule(): NativeVouchflowModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native') as { NativeModules?: Record<string, unknown> };
    return rn.NativeModules?.Vouchflow as NativeVouchflowModule | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Production wiring — Phase 5b. Calls `NativeModules.Vouchflow.verify()`
 * (Kotlin module under `apps/mobile/android/.../vouchflow/`, wrapping
 * `dev.vouchflow:android-sdk`). Throws `VouchflowClientError` with a
 * `reason` mirroring the SDK's `VouchflowError` subtypes.
 *
 * 🍎 iOS counterpart bridge is queued — see spec §11 Phase 5b.
 */
export class NativeVouchflowClient implements VouchflowClient {
  private readonly module: NativeVouchflowModule;

  constructor() {
    const m = loadNativeModule();
    if (!m) {
      throw new VouchflowClientError(
        'unknown_error',
        'NativeVouchflowClient: Vouchflow native module not registered. ' +
          'Are you running on a real device with the Phase 5b APK?',
      );
    }
    this.module = m;
  }

  async verify(opts: VerifyOpts): Promise<VerifyResult> {
    try {
      const r = await this.module.verify(opts.context, opts.minimumConfidence ?? null);
      return {
        verified: r.verified,
        confidence: r.confidence as Confidence,
        deviceToken: r.deviceToken,
        fallbackUsed: r.fallbackUsed,
        signals: r.signals,
      };
    } catch (err) {
      // RN's NativeModules reject with { code, message } shaped errors.
      const reason = (err as { code?: VouchflowErrorReason }).code ?? 'unknown_error';
      throw new VouchflowClientError(reason, (err as Error).message);
    }
  }
}
