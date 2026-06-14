package xyz.speakeasyapp.app.vouchflow

import android.util.Log
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

private const val TAG = "VouchflowModule"

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
        Log.e(TAG, "verify: biometric_cancelled", e)
        promise.reject("biometric_cancelled", e.message, e)
      } catch (e: VouchflowError.BiometricFailed) {
        Log.e(TAG, "verify: biometric_failed", e)
        promise.reject("biometric_failed", e.message, e)
      } catch (e: VouchflowError.BiometricUnavailable) {
        Log.e(TAG, "verify: biometric_unavailable", e)
        promise.reject("biometric_unavailable", e.message, e)
      } catch (e: VouchflowError.MinimumConfidenceUnmet) {
        Log.e(TAG, "verify: minimum_confidence_unmet", e)
        promise.reject("minimum_confidence_unmet", e.message, e)
      } catch (e: VouchflowError.NetworkUnavailable) {
        Log.e(TAG, "verify: network_unavailable", e)
        promise.reject("network_unavailable", e.message, e)
      } catch (e: VouchflowError.EnrollmentFailed) {
        // EnrollmentFailed in SDK 2.0.0 carries the original exception
        // in `enrollmentCause: Throwable?` (NOT in the standard
        // Throwable.cause chain). Network and ServerError rejections
        // throw their own subtypes — so an EnrollmentFailed here means
        // local key-generation/attestation failed, typically on
        // emulators that don't expose AndroidKeyStore EC properly.
        // Per Vouchflow SDK engineering: log enrollmentCause to learn
        // the actual class (KeyStoreException / ProviderException /
        // IllegalStateException etc).
        Log.e(TAG, "verify: enrollment_failed; message=${e.message}", e)
        val rootCause = e.enrollmentCause
        if (rootCause != null) {
          Log.e(TAG, "verify: enrollment_failed enrollmentCause (${rootCause.javaClass.name}): ${rootCause.message}", rootCause)
          var c: Throwable? = rootCause.cause
          var depth = 0
          while (c != null && depth < 8) {
            Log.e(TAG, "verify: enrollment_failed enrollmentCause.cause[$depth] (${c.javaClass.name}): ${c.message}", c)
            c = c.cause
            depth++
          }
        } else {
          Log.e(TAG, "verify: enrollment_failed has null enrollmentCause")
        }
        promise.reject("enrollment_failed", rootCause?.let { "${it.javaClass.simpleName}: ${it.message}" } ?: e.message ?: e.toString(), e)
      } catch (e: VouchflowError.AccountStoreAccessDenied) {
        Log.e(TAG, "verify: account_store_access_denied", e)
        promise.reject("account_store_access_denied", e.message, e)
      } catch (e: VouchflowError.DeviceClaimedElsewhere) {
        // SDK 2.3.0: the device's token belongs to a different App row
        // (the sandbox→production split). Surfaced as a typed code so JS
        // can show an actionable message instead of an opaque 403; the
        // server-side device transfer is the recovery (see android-sdk#6).
        Log.e(TAG, "verify: device_claimed_elsewhere", e)
        promise.reject("device_claimed_elsewhere", e.message, e)
      } catch (e: VouchflowError.PublicKeyAlreadyRegistered) {
        // SDK 2.3.0: post server-v59 this only fires for genuine
        // cross-tenant key collisions.
        Log.e(TAG, "verify: public_key_already_registered", e)
        promise.reject("public_key_already_registered", e.message, e)
      } catch (e: Throwable) {
        Log.e(TAG, "verify: unknown_error (${e.javaClass.name})", e)
        promise.reject("unknown_error", e.message ?: e.toString(), e)
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
}
