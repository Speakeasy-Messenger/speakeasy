//
//  VouchflowModule.swift
//  Speakeasy
//
//  Phase 5b iOS — RN bridge to the Vouchflow iOS SDK.
//  Mirrors apps/mobile/android/.../vouchflow/VouchflowModule.kt
//
//  JS interface: see apps/mobile/src/native/vouchflow.ts
//
//  Wire format: methods take JS-friendly types (NSString context,
//  NSString? minimumConfidence) and resolve with a JS dictionary
//  matching the Android resolve shape exactly:
//    { verified: Bool,
//      confidence: "high" | "medium" | "low",
//      deviceToken: String,
//      deviceAgeDays: Int,
//      networkVerifications: Int,
//      firstSeen: String?,   // ISO 8601 or null
//      context: String,      // "signup" | "login" | "sensitive_action"
//      fallbackUsed: Bool,
//      signals: { biometricUsed, attestationVerified, persistentToken,
//                 crossAppHistory, anomalyFlags } }
//
//  SDK 2.0.0 adds:
//    - requestFallback(email:reason:) → { fallbackSessionId, expiresAt }
//    - submitFallbackOtp(sessionId:otp:) → { verified, confidence, sessionState,
//                                             fallbackSignals }
//    - VouchflowResult now includes deviceAgeDays, networkVerifications,
//      firstSeen, context
//    - VouchflowError.biometricCancelled(sessionId) / .biometricFailed(sessionId)
//    - VouchflowError.keychainAccessDenied (was .keychainAccessDenied in 1.x)
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

    // MARK: - Verify

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

    // MARK: - Fallback

    /// Initiate email OTP fallback. Call after catching biometricCancelled or biometricFailed.
    @objc(requestFallback:reason:resolver:rejecter:)
    func requestFallback(_ email: NSString,
                         reason: NSString?,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        let fallbackReason = parseFallbackReason(reason as String?)

        Task { @MainActor in
            do {
                let result = try await Vouchflow.shared.requestFallback(
                    email: email as String,
                    reason: fallbackReason
                )
                resolve([
                    "fallbackSessionId": result.fallbackSessionId,
                    "expiresAt": ISO8601DateFormatter().string(from: result.expiresAt)
                ])
            } catch let err as VouchflowError {
                let (code, message) = mapError(err)
                reject(code, message, err)
            } catch {
                reject("unknown_error", error.localizedDescription, error)
            }
        }
    }

    /// Submit OTP code for a fallback session.
    @objc(submitFallbackOtp:otp:resolver:rejecter:)
    func submitFallbackOtp(_ sessionId: NSString,
                           otp: NSString,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task { @MainActor in
            do {
                let result = try await Vouchflow.shared.submitFallbackOTP(
                    sessionId: sessionId as String,
                    otp: otp as String
                )
                resolve([
                    "verified": result.verified,
                    "confidence": confidenceString(result.confidence),
                    "sessionState": result.sessionState,
                    "fallbackSignals": [
                        "ipConsistent": result.fallbackSignals.ipConsistent,
                        "disposableEmailDomain": result.fallbackSignals.disposableEmailDomain,
                        "deviceHasPriorVerifications": result.fallbackSignals.deviceHasPriorVerifications,
                        "emailDomainAgeDays": result.fallbackSignals.emailDomainAgeDays as Any,
                        "otpAttempts": result.fallbackSignals.otpAttempts,
                        "timeToCompleteSeconds": result.fallbackSignals.timeToCompleteSeconds
                    ]
                ])
            } catch let err as VouchflowError {
                let (code, message) = mapError(err)
                reject(code, message, err)
            } catch {
                reject("unknown_error", error.localizedDescription, error)
            }
        }
    }

  /// Read the locally-cached device token without triggering biometric or
  /// network calls. Returns null if the device has never enrolled.
  @objc(getCachedDeviceToken:rejecter:)
  func getCachedDeviceToken(_ resolve: RCTPromiseResolveBlock,
                            rejecter reject: RCTPromiseRejectBlock) {
    resolve(Vouchflow.shared.cachedDeviceToken)
  }

    // MARK: - Helpers

    private func parseContext(_ s: String) -> VerificationContext? {
        switch s {
        case "signup":              return .signup
        case "login":               return .login
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

    private func parseFallbackReason(_ s: String?) -> FallbackReason {
        switch s {
        case "attestation_unavailable": return .attestationUnavailable
        case "attestation_failed":      return .attestationFailed
        case "attestation_timeout":     return .attestationTimeout
        case "biometric_unavailable":   return .biometricUnavailable
        case "biometric_failed":        return .biometricFailed
        case "biometric_cancelled":     return .biometricCancelled
        case "key_invalidated":         return .keyInvalidated
        case "sdk_error":               return .sdkError
        case "minimum_confidence_unmet": return .minimumConfidenceUnmet
        case "developer_initiated":     return .developerInitiated
        case "enrollment_failed":       return .enrollmentFailed
        default:                        return .biometricFailed
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

    private func contextString(_ c: VerificationContext) -> String {
        switch c {
        case .signup:          return "signup"
        case .login:           return "login"
        case .sensitiveAction: return "sensitive_action"
        @unknown default:      return "login"
        }
    }

    /// Serialize VouchflowResult → JS dict matching the Android shape.
    private func serialize(_ r: VouchflowResult) -> [String: Any] {
        let signals: [String: Any] = [
            "biometricUsed":        r.signals.biometricUsed,
            "attestationVerified":  r.signals.attestationVerified,
            "persistentToken":      r.signals.keychainPersistent,
            "crossAppHistory":      r.signals.crossAppHistory,
            "anomalyFlags":         r.signals.anomalyFlags
        ]
        var firstSeenStr: String? = nil
        if let firstSeen = r.firstSeen {
            firstSeenStr = ISO8601DateFormatter().string(from: firstSeen)
        }
        return [
            "verified":             r.verified,
            "confidence":           confidenceString(r.confidence),
            "deviceToken":          r.deviceToken,
            "deviceAgeDays":        r.deviceAgeDays,
            "networkVerifications": r.networkVerifications,
            "firstSeen":            firstSeenStr as Any,
            "context":              contextString(r.context),
            "fallbackUsed":         r.fallbackUsed,
            "signals":              signals
        ]
    }

    /// Map VouchflowError cases → JS error codes mirroring the Kotlin
    /// VouchflowError sealed-class mapping in
    /// android/.../vouchflow/VouchflowModule.kt.
    private func mapError(_ err: VouchflowError) -> (code: String, message: String) {
        switch err {
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
        case .keychainAccessDenied:     return ("account_store_access_denied", "keychain access denied")
        case .sessionExpiredRepeatedly: return ("unknown_error",             "session expired")
        @unknown default:               return ("unknown_error",             "unknown VouchflowError")
        }
    }
}
