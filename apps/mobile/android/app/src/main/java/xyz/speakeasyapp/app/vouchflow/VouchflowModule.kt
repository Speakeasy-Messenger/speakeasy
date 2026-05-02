package xyz.speakeasyapp.app.vouchflow

import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import dev.vouchflow.sdk.Confidence
import dev.vouchflow.sdk.FallbackReason
import dev.vouchflow.sdk.VerificationContext
import dev.vouchflow.sdk.Vouchflow
import dev.vouchflow.sdk.VouchflowError
import java.time.Instant
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * RN bridge for the Vouchflow Android SDK (`dev.vouchflow:android-sdk`).
 *
 * Phase 5b: legacy ReactContextBaseJavaModule (not Turbo) — Turbo modules
 * need codegen specs, which is overkill for a single 1-method bridge.
 * Migration to Turbo can land in a later phase if perf becomes a concern.
 *
 * Methods:
 *   verify(context, minimumConfidence | null) → Promise<{
 *     verified, confidence, deviceToken, fallbackUsed,
 *     deviceAgeDays, networkVerifications, firstSeen, context,
 *     signals: { biometricUsed, attestationVerified, persistentToken,
 *                crossAppHistory, anomalyFlags },
 *   }>
 *   requestFallback(email, reasonStr | null) → Promise<{
 *     fallbackSessionId, expiresAt,
 *   }>
 *   submitFallbackOtp(sessionId, otp) → Promise<{
 *     verified, confidence, sessionState,
 *     fallbackSignals: { ipConsistent, disposableEmailDomain,
 *       deviceHasPriorVerifications, emailDomainAgeDays, otpAttempts,
 *       timeToCompleteSeconds },
 *   }>
 *
 * Errors are rejected with codes mirroring `VouchflowError` subtypes:
 *   biometric_cancelled · biometric_failed · biometric_unavailable
 *   minimum_confidence_unmet · network_unavailable · enrollment_failed
 *   account_store_access_denied · no_activity · bad_context
 *   bad_confidence · bad_fallback_reason · unknown_error
 *
 * `Vouchflow.configure()` is called in MainApplication.onCreate(), not here.
 */
class VouchflowModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

  override fun getName(): String = "Vouchflow"

  @ReactMethod
  fun verify(contextStr: String, minimumConfidenceStr: String?, promise: Promise) {
    val activity = currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject("no_activity", "verify() requires a foreground FragmentActivity")
      return
    }
    val ctx =
        when (contextStr) {
          "signup" -> VerificationContext.SIGNUP
          "login" -> VerificationContext.LOGIN
          "sensitive_action" -> VerificationContext.SENSITIVE_ACTION
          else -> {
            promise.reject("bad_context", "unknown context: $contextStr")
            return
          }
        }
    val minConf =
        minimumConfidenceStr?.let {
          when (it) {
            "high" -> Confidence.HIGH
            "medium" -> Confidence.MEDIUM
            "low" -> Confidence.LOW
            else -> {
              promise.reject("bad_confidence", "unknown confidence: $it")
              return
            }
          }
        }

    scope.launch {
      try {
        val result =
            if (minConf != null) {
              Vouchflow.shared.verify(
                  activity = activity, context = ctx, minimumConfidence = minConf)
            } else {
              Vouchflow.shared.verify(activity = activity, context = ctx)
            }
        val signals =
            Arguments.createMap().apply {
              putBoolean("biometricUsed", result.signals.biometricUsed)
              putBoolean("attestationVerified", result.signals.attestationVerified)
              putBoolean("persistentToken", result.signals.persistentToken)
              putBoolean("crossAppHistory", result.signals.crossAppHistory)
              val flags = Arguments.createArray()
              result.signals.anomalyFlags.forEach { flags.pushString(it) }
              putArray("anomalyFlags", flags)
            }
        val map =
            Arguments.createMap().apply {
              putBoolean("verified", result.verified)
              putString("confidence", result.confidence.name.lowercase())
              putString("deviceToken", result.deviceToken)
              putBoolean("fallbackUsed", result.fallbackUsed)
              putInt("deviceAgeDays", result.deviceAgeDays)
              putInt("networkVerifications", result.networkVerifications)
              putString("firstSeen", result.firstSeen?.let { DateTimeFormatter.ISO_INSTANT.format(it) })
              putString("context", result.context.name.lowercase())
              putMap("signals", signals)
            }
        promise.resolve(map)
      } catch (e: VouchflowError.BiometricCancelled) {
        promise.reject("biometric_cancelled", e.message, e)
      } catch (e: VouchflowError.BiometricFailed) {
        promise.reject("biometric_failed", e.message, e)
      } catch (e: VouchflowError.BiometricUnavailable) {
        promise.reject("biometric_unavailable", e.message, e)
      } catch (e: VouchflowError.MinimumConfidenceUnmet) {
        promise.reject("minimum_confidence_unmet", e.message, e)
      } catch (e: VouchflowError.NetworkUnavailable) {
        promise.reject("network_unavailable", e.message, e)
      } catch (e: VouchflowError.EnrollmentFailed) {
        promise.reject("enrollment_failed", e.message, e)
      } catch (e: VouchflowError.AccountStoreAccessDenied) {
        promise.reject("account_store_access_denied", e.message, e)
      } catch (e: Throwable) {
        promise.reject("unknown_error", e.message, e)
      }
    }
  }

  /**
   * Request an OTP fallback verification via email.
   *
   * Maps `reasonStr` to `FallbackReason` enum, falling back to
   * `BIOMETRIC_FAILED` if null/unrecognised.
   */
  @ReactMethod
  fun requestFallback(email: String, reasonStr: String?, promise: Promise) {
    val reason =
        when (reasonStr) {
          "biometric_failed" -> FallbackReason.BIOMETRIC_FAILED
          "biometric_cancelled" -> FallbackReason.BIOMETRIC_CANCELLED
          "biometric_unavailable" -> FallbackReason.BIOMETRIC_UNAVAILABLE
          "attestation_unavailable" -> FallbackReason.ATTESTATION_UNAVAILABLE
          null -> FallbackReason.BIOMETRIC_FAILED
          else -> {
            promise.reject("bad_fallback_reason", "unknown fallback reason: $reasonStr")
            return
          }
        }

    scope.launch {
      try {
        val result = Vouchflow.shared.requestFallback(email, reason)
        val map =
            Arguments.createMap().apply {
              putString("fallbackSessionId", result.fallbackSessionId)
              putString("expiresAt", DateTimeFormatter.ISO_INSTANT.format(result.expiresAt))
            }
        promise.resolve(map)
      } catch (e: Throwable) {
        promise.reject("unknown_error", e.message, e)
      }
    }
  }

  /**
   * Submit an OTP code for a fallback verification session.
   */
  @ReactMethod
  fun submitFallbackOtp(sessionId: String, otp: String, promise: Promise) {
    scope.launch {
      try {
        val result = Vouchflow.shared.submitFallbackOtp(sessionId, otp)
        val fallbackSignals =
            Arguments.createMap().apply {
              putBoolean("ipConsistent", result.fallbackSignals.ipConsistent)
              putBoolean("disposableEmailDomain", result.fallbackSignals.disposableEmailDomain)
              putBoolean("deviceHasPriorVerifications", result.fallbackSignals.deviceHasPriorVerifications)
              val emailAgeDays = result.fallbackSignals.emailDomainAgeDays
              if (emailAgeDays != null) putInt("emailDomainAgeDays", emailAgeDays)
              putInt("otpAttempts", result.fallbackSignals.otpAttempts)
              putDouble("timeToCompleteSeconds", result.fallbackSignals.timeToCompleteSeconds.toDouble())
            }
        val map =
            Arguments.createMap().apply {
              putBoolean("verified", result.verified)
              putString("confidence", result.confidence.name.lowercase())
              putString("sessionState", result.sessionState)
              putMap("fallbackSignals", fallbackSignals)
            }
        promise.resolve(map)
      } catch (e: Throwable) {
        promise.reject("unknown_error", e.message, e)
      }
    }
  }

  /**
   * Read the locally-cached device token without triggering biometric or
   * network calls. Returns null if the device has never enrolled.
   * Useful when biometric is unavailable — the device may still be enrolled.
   */
  @ReactMethod
  fun getCachedDeviceToken(promise: Promise) {
    val token = Vouchflow.shared.cachedDeviceToken
    promise.resolve(token)
  }

  /**
   * Test-only: enroll the device without requiring biometric verification.
   * Uses SDK 2.0.0 fallback test flow:
   *   1. initiateSessionForFallbackTesting() → sessionId (String)
   *   2. submitFallbackOtp(sessionId, otp) → FallbackCompleteResponse
   *   3. getCachedDeviceToken() → device token
   * Used by CI emulators that lack biometric hardware.
   * Returns the device token on success.
   */
  @ReactMethod
  fun ensureEnrolledForTesting(promise: Promise) {
    CoroutineScope(Dispatchers.IO).launch {
      try {
        val sessionId = Vouchflow.shared.initiateSessionForFallbackTesting()
        // Test sessions accept the session ID itself as the OTP
        val fallbackResult = Vouchflow.shared.submitFallbackOtp(sessionId, sessionId)
        if (!fallbackResult.verified) {
          promise.reject("enrollment_failed", "Fallback verification not verified")
          return@launch
        }
        val token = Vouchflow.shared.cachedDeviceToken
        if (token != null) {
          promise.resolve(token)
        } else {
          promise.reject("enrollment_failed", "Device token is null after fallback enrollment")
        }
      } catch (e: Throwable) {
        promise.reject("enrollment_failed", e.message, e)
      }
    }
  }
}
