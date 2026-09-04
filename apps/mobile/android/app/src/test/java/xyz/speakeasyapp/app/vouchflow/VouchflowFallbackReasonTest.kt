package xyz.speakeasyapp.app.vouchflow

import dev.vouchflow.sdk.FallbackReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VouchflowFallbackReasonTest {
  @Test
  fun `parses every supported fallback reason`() {
    val cases =
        mapOf(
            "attestation_unavailable" to FallbackReason.ATTESTATION_UNAVAILABLE,
            "attestation_failed" to FallbackReason.ATTESTATION_FAILED,
            "attestation_timeout" to FallbackReason.ATTESTATION_TIMEOUT,
            "biometric_unavailable" to FallbackReason.BIOMETRIC_UNAVAILABLE,
            "biometric_failed" to FallbackReason.BIOMETRIC_FAILED,
            "biometric_cancelled" to FallbackReason.BIOMETRIC_CANCELLED,
            "key_invalidated" to FallbackReason.KEY_INVALIDATED,
            "sdk_error" to FallbackReason.SDK_ERROR,
            "minimum_confidence_unmet" to FallbackReason.MINIMUM_CONFIDENCE_UNMET,
            "developer_initiated" to FallbackReason.DEVELOPER_INITIATED,
            "enrollment_failed" to FallbackReason.ENROLLMENT_FAILED,
        )

    cases.forEach { (reason, expected) ->
      assertEquals(expected, parseFallbackReason(reason))
    }
  }

  @Test
  fun `defaults a missing reason to biometric failed`() {
    assertEquals(FallbackReason.BIOMETRIC_FAILED, parseFallbackReason(null))
  }

  @Test
  fun `rejects an unknown fallback reason`() {
    assertThrows(IllegalArgumentException::class.java) {
      parseFallbackReason("not_a_fallback_reason")
    }
  }
}
