package xyz.speakeasyapp.app.vouchflow

import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import dev.vouchflow.sdk.Confidence
import dev.vouchflow.sdk.VerificationContext
import dev.vouchflow.sdk.Vouchflow
import dev.vouchflow.sdk.VouchflowError
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
 *     signals: { biometricUsed, attestationVerified, persistentToken,
 *                crossAppHistory, anomalyFlags },
 *   }>
 *
 * Errors are rejected with codes mirroring `VouchflowError` subtypes:
 *   biometric_cancelled · biometric_failed · biometric_unavailable
 *   minimum_confidence_unmet · network_unavailable · enrollment_failed
 *   no_activity · bad_context · bad_confidence · unknown_error
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
      } catch (e: Throwable) {
        promise.reject("unknown_error", e.message, e)
      }
    }
  }
}
