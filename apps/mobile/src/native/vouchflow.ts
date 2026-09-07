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
 * SDK 2.0.0 adds:
 *   - VouchflowResult.deviceAgeDays, networkVerifications, firstSeen, context
 *   - BiometricCancelled/Failed now carry sessionId
 *   - AccountStoreAccessDenied error (iOS: keychainAccessDenied)
 */

export interface VouchflowSignals {
  biometricUsed: boolean;
  attestationVerified: boolean;
  /** SDK 2.0.0: renamed from `keychainPersistent` in Android; iOS bridge remaps. */
  persistentToken: boolean;
  crossAppHistory: boolean;
  anomalyFlags: string[];
}

export interface VerifyResult {
  verified: boolean;
  confidence: Confidence;
  deviceToken: string;
  /** SDK 2.0.0: days since this device token was first enrolled. */
  deviceAgeDays: number;
  /** SDK 2.0.0: total verifications in the Vouchflow network. */
  networkVerifications: number;
  /** SDK 2.0.0: ISO 8601 timestamp or null. */
  firstSeen: string | null;
  /** SDK 2.0.0: the VerificationContext passed to verify(). */
  context: VerificationContext;
  signals: VouchflowSignals;
  fallbackUsed: boolean;
}

export interface VerifyOpts {
  context: VerificationContext;
  /** SDK throws `MinimumConfidenceUnmet` if the device can't reach this. */
  minimumConfidence?: Confidence;
}

export type FallbackReason =
  | 'attestation_unavailable'
  | 'attestation_failed'
  | 'attestation_timeout'
  | 'biometric_unavailable'
  | 'biometric_failed'
  | 'biometric_cancelled'
  | 'key_invalidated'
  | 'sdk_error'
  | 'minimum_confidence_unmet'
  | 'developer_initiated'
  | 'enrollment_failed';

export interface VouchflowClient {
  /** Full attestation flow. Returns the `deviceToken` to pass to your server. */
  verify(opts: VerifyOpts): Promise<VerifyResult>;
  /** Read the cached device token without biometric/network. Null if not enrolled. */
  getCachedDeviceToken(): Promise<string | null>;
}

/** Mirrors the Kotlin `VouchflowError` sealed class (SDK 2.0.0). */
export type VouchflowErrorReason =
  | 'biometric_cancelled'
  | 'biometric_failed'
  | 'biometric_unavailable'
  | 'attestation_unavailable'
  | 'minimum_confidence_unmet'
  | 'network_unavailable'
  | 'enrollment_failed'
  | 'no_session'
  | 'account_store_access_denied'
  | 'bad_context'
  | 'bad_confidence'
  | 'bad_fallback_reason'
  | 'unknown_error';

export class VouchflowClientError extends Error {
  constructor(
    public readonly reason: VouchflowErrorReason,
    message?: string,
  ) {
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
    deviceAgeDays: number;
    networkVerifications: number;
    firstSeen: string | null;
    context: string;
    fallbackUsed: boolean;
    signals: VouchflowSignals;
  }>;
  /** Returns the cached device token (null if never enrolled). */
  getCachedDeviceToken(): Promise<string | null>;
}

/**
 * Conditional require of `react-native`. In RN production bundles the module
 * is provided globally by Metro. In Node test envs (vitest) the require
 * throws — callers should not use this class directly in tests.
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
 * Production wiring — calls `NativeModules.Vouchflow.verify()`
 * (Kotlin/Swift modules wrapping `dev.vouchflow:android-sdk:2.0.0` /
 * `VouchflowSDK` 2.0.0). Throws `VouchflowClientError` with a
 * `reason` mirroring the SDK's `VouchflowError` subtypes.
 */
export class NativeVouchflowClient implements VouchflowClient {
  private readonly module: NativeVouchflowModule;

  constructor() {
    const m = loadNativeModule();
    if (!m) {
      throw new VouchflowClientError(
        'unknown_error',
        'NativeVouchflowClient: Vouchflow native module not registered. ' +
          'Are you running on a real device with the SDK 2.0.0 APK?',
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
        deviceAgeDays: r.deviceAgeDays,
        networkVerifications: r.networkVerifications,
        firstSeen: r.firstSeen,
        context: r.context as VerificationContext,
        fallbackUsed: r.fallbackUsed,
        signals: r.signals,
      };
    } catch (err) {
      const reason = (err as { code?: VouchflowErrorReason }).code ?? 'unknown_error';
      throw new VouchflowClientError(reason, (err as Error).message);
    }
  }

  async getCachedDeviceToken(): Promise<string | null> {
    return this.module.getCachedDeviceToken();
  }
}
