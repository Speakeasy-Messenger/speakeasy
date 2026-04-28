//
//  VouchflowModule.swift
//  Speakeasy
//
//  Phase 5b iOS — RN bridge to the Vouchflow iOS SDK.
//  Mirrors apps/mobile/android/.../vouchflow/VouchflowModule.kt
//
//  JS interface: see packages/mobile/src/native/vouchflow.ts
//
//  Wire format: methods take JS-friendly types (NSString context,
//  NSString? minimumConfidence) and resolve with a JS dictionary
//  matching the Android resolve shape exactly:
//    { verified: Bool,
//      confidence: "high" | "medium" | "low",
//      deviceToken: String,
//      fallbackUsed: Bool,
//      signals: { biometricUsed, attestationVerified, persistentToken,
//                 crossAppHistory, anomalyFlags } }
//
//  Reject codes mirror the Kotlin VouchflowError sealed-class mapping.
//

import Foundation
import VouchflowSDK

@objc(VouchflowModule)
class VouchflowModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool {
        // Vouchflow's biometric prompt + UIWindow lookup must run on the
        // main thread — keep module construction there too.
        return true
    }

    /// JS entry point. Async (RN bridge promise) wrapping the SDK's async
    /// `verify(context:minimumConfidence:)`.
    @objc(verify:minimumConfidence:resolver:rejecter:)
    func verify(_ contextRaw: NSString,
                minimumConfidence: NSString?,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let context = parseContext(contextRaw as String) else {
            reject("bad_context", "unknown verification context: \(contextRaw)", nil)
            return
        }
        let minConfidence = parseConfidence(minimumConfidence as String?)
        if minimumConfidence != nil && minConfidence == nil {
            reject("bad_confidence", "unknown confidence: \(minimumConfidence!)", nil)
            return
        }

        Task { @MainActor in
            do {
                // Vouchflow iOS SDK — verify is presented modally over the
                // top-most view controller. The SDK locates that via
                // UIApplication.shared.connectedScenes; no need to pass it.
                let result = try await Vouchflow.shared.verify(
                    context: context,
                    minimumConfidence: minConfidence
                )
                resolve(serialize(result))
            } catch let err as VouchflowError {
                let (code, message) = mapError(err)
                reject(code, message, err)
            } catch {
                reject("unknown_error", error.localizedDescription, error)
            }
        }
    }

    // MARK: - Helpers

    private func parseContext(_ s: String) -> VerificationContext? {
        switch s {
        case "signup":              return .signup
        case "login":               return .login
        // VouchflowSDK 1.0.3: no `.transaction` case — `sensitive_action`
        // covers the use case. JS callers may still send "transaction" for
        // Android compatibility; map it to `.sensitiveAction`.
        case "transaction":         return .sensitiveAction
        case "sensitive_action":    return .sensitiveAction
        default:                    return nil
        }
    }

    private func parseConfidence(_ s: String?) -> Confidence? {
        guard let s = s else { return nil }
        switch s {
        case "high":   return .high
        case "medium": return .medium
        case "low":    return .low
        default:       return nil
        }
    }

    private func confidenceString(_ c: Confidence) -> String {
        switch c {
        case .high:   return "high"
        case .medium: return "medium"
        case .low:    return "low"
        @unknown default: return "low"
        }
    }

    /// Serialize VouchflowResult → JS dict matching the Android shape.
    private func serialize(_ r: VouchflowResult) -> [String: Any] {
        // The iOS SDK's signal property name is `keychainPersistent`. The
        // Android SDK renamed its equivalent to `persistentToken` in the
        // April 2026 revision. JS-side code uses `persistentToken`, so we
        // remap here at the bridge boundary.
        let signals: [String: Any] = [
            "biometricUsed":        r.signals.biometricUsed,
            "attestationVerified":  r.signals.attestationVerified,
            "persistentToken":      r.signals.keychainPersistent,
            "crossAppHistory":      r.signals.crossAppHistory,
            "anomalyFlags":         r.signals.anomalyFlags
        ]
        return [
            "verified":     r.verified,
            "confidence":   confidenceString(r.confidence),
            "deviceToken":  r.deviceToken,
            "fallbackUsed": r.fallbackUsed,
            "signals":      signals
        ]
    }

    /// Map VouchflowError cases → JS error codes mirroring the Kotlin
    /// VouchflowError sealed-class mapping in
    /// android/.../vouchflow/VouchflowModule.kt.
    private func mapError(_ err: VouchflowError) -> (code: String, message: String) {
        switch err {
        // Bare matches (no value binding) on cases-with-associated-values
        // — `.biometricCancelled(sessionId:)` and friends — work fine here.
        case .biometricCancelled:       return ("biometric_cancelled",       "biometric prompt cancelled")
        case .biometricFailed:          return ("biometric_failed",          "biometric verification failed")
        case .biometricUnavailable:     return ("biometric_unavailable",     "biometric not available on device")
        case .minimumConfidenceUnmet:   return ("minimum_confidence_unmet",  "device cannot meet minimum confidence")
        case .networkUnavailable:       return ("network_unavailable",       "no network")
        case .enrollmentFailed:         return ("enrollment_failed",         "device enrollment failed")
        case .noActiveSession:          return ("no_session",                "no active session")
        case .invalidAPIKey:            return ("unknown_error",             "invalid Vouchflow API key")
        case .notConfigured:            return ("unknown_error",             "Vouchflow.configure not called")
        case .pinningFailure:           return ("network_unavailable",       "tls pinning failure")
        case .serverError:              return ("unknown_error",             "vouchflow server error")
        case .attestationUnavailable:   return ("unknown_error",             "device attestation unavailable")
        case .keychainAccessDenied:     return ("unknown_error",             "keychain access denied")
        case .sessionExpiredRepeatedly: return ("unknown_error",             "session expired")
        // `__sessionExpiredInternal` is a private case the SDK never
        // surfaces to the developer — handled by the @unknown default.
        @unknown default:               return ("unknown_error",             "unknown VouchflowError")
        }
    }
}
