package xyz.speakeasyapp.app.channelkey

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import xyz.speakeasyapp.app.signal.SpeakeasySignalStore
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.kdf.HKDF
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Channel-key crypto for community chats — spec §4b.
 *
 * One AES-256 key K per community, generated on the creator's device.
 * Distributed via per-recipient envelopes (one wrap per member). Server
 * relays envelopes; never sees plaintext K.
 *
 * **Wire format — KEEP IN SYNC WITH IOS COUNTERPART** (`apps/mobile/ios`,
 * Phase 5b iOS sweep, currently 🍎 deferred):
 *
 *   wrapForRecipient envelope:
 *     bytes 0..32   ephemeralPublicKey  (33 bytes — libsignal's
 *                                        DjbECPublicKey serialization,
 *                                        leading 0x05 type byte + 32 key)
 *     bytes 33..44  iv                  (12 bytes — AES-GCM nonce)
 *     bytes 45..    ciphertext          (K encrypted under HKDF(ECDH) +
 *                                        AES-GCM-128 tag at the end)
 *
 *   encryptMessage output:
 *     bytes 0..11   iv                  (12 bytes — AES-GCM nonce)
 *     bytes 12..    ciphertext          (plaintext encrypted under K
 *                                        + AES-GCM-128 tag at the end)
 *
 * HKDF salt is empty; info string is `speakeasy-channel-key-wrap-v1`.
 *
 * The `SoftwareChannelKeyModule` test fixture in @speakeasy/crypto stays
 * the unit-test backbone; it uses a simpler symmetric scheme that is
 * intentionally not wire-compatible with this real impl (test-only).
 */
class ChannelKeyModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ChannelKey"

  private val rng = SecureRandom()
  private val hkdfInfo = "speakeasy-channel-key-wrap-v1".toByteArray(Charsets.UTF_8)
  private val ephemeralPubKeyBytes = 33 // libsignal DjbECPublicKey serialized length
  private val ivBytes = 12
  private val tagBits = 128

  private fun b64(bytes: ByteArray): String =
      Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

  @ReactMethod
  fun generateChannelKey(promise: Promise) {
    try {
      val k = ByteArray(32)
      rng.nextBytes(k)
      promise.resolve(b64(k))
    } catch (e: Throwable) {
      promise.reject("generate_failed", e.message, e)
    }
  }

  @ReactMethod
  fun wrapForRecipient(channelKeyB64: String, recipientPublicKeyB64: String, promise: Promise) {
    try {
      val k = unb64(channelKeyB64)
      if (k.size != 32) {
        promise.reject("bad_channel_key", "channel key must be 32 bytes")
        return
      }
      val recipPub = Curve.decodePoint(unb64(recipientPublicKeyB64), 0)

      // ECIES: ephemeral X25519 keypair × recipient's identity public key.
      val ephemeral = Curve.generateKeyPair()
      val sharedSecret = Curve.calculateAgreement(recipPub, ephemeral.privateKey)

      // HKDF-SHA256(sharedSecret, salt=empty, info) → 32-byte AES key.
      val derived = HKDF.deriveSecrets(sharedSecret, hkdfInfo, 32)

      // AES-256-GCM(derived, iv, K)
      val iv = ByteArray(ivBytes)
      rng.nextBytes(iv)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
          Cipher.ENCRYPT_MODE,
          SecretKeySpec(derived, "AES"),
          GCMParameterSpec(tagBits, iv))
      val ct = cipher.doFinal(k)

      val ephPub = ephemeral.publicKey.serialize()
      if (ephPub.size != ephemeralPubKeyBytes) {
        promise.reject(
            "bad_eph_pub_size",
            "expected ephemeral pubkey size $ephemeralPubKeyBytes, got ${ephPub.size}")
        return
      }

      val envelope =
          ByteBuffer.allocate(ephPub.size + iv.size + ct.size)
              .put(ephPub)
              .put(iv)
              .put(ct)
              .array()
      promise.resolve(b64(envelope))
    } catch (e: Throwable) {
      promise.reject("wrap_failed", e.message, e)
    }
  }

  @ReactMethod
  fun unwrapForSelf(envelopeB64: String, promise: Promise) {
    try {
      val envelope = unb64(envelopeB64)
      val minSize = ephemeralPubKeyBytes + ivBytes + 1 // at least 1 ct byte
      if (envelope.size < minSize) {
        promise.reject("bad_envelope", "envelope too short")
        return
      }
      val ephPubBytes = envelope.copyOfRange(0, ephemeralPubKeyBytes)
      val iv = envelope.copyOfRange(ephemeralPubKeyBytes, ephemeralPubKeyBytes + ivBytes)
      val ct = envelope.copyOfRange(ephemeralPubKeyBytes + ivBytes, envelope.size)

      val store = SpeakeasySignalStore.requireInitialized()
      val myPriv = store.identityKeyPair.privateKey

      val ephPub = Curve.decodePoint(ephPubBytes, 0)
      val sharedSecret = Curve.calculateAgreement(ephPub, myPriv)
      val derived = HKDF.deriveSecrets(sharedSecret, hkdfInfo, 32)

      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
          Cipher.DECRYPT_MODE,
          SecretKeySpec(derived, "AES"),
          GCMParameterSpec(tagBits, iv))
      val k = cipher.doFinal(ct)
      promise.resolve(b64(k))
    } catch (e: Throwable) {
      promise.reject("unwrap_failed", e.message, e)
    }
  }

  @ReactMethod
  fun encryptMessage(channelKeyB64: String, plaintextB64: String, promise: Promise) {
    try {
      val k = unb64(channelKeyB64)
      if (k.size != 32) {
        promise.reject("bad_channel_key", "channel key must be 32 bytes")
        return
      }
      val plaintext = unb64(plaintextB64)
      val iv = ByteArray(ivBytes)
      rng.nextBytes(iv)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(tagBits, iv))
      val ct = cipher.doFinal(plaintext)
      val out = ByteArray(iv.size + ct.size)
      System.arraycopy(iv, 0, out, 0, iv.size)
      System.arraycopy(ct, 0, out, iv.size, ct.size)
      promise.resolve(b64(out))
    } catch (e: Throwable) {
      promise.reject("encrypt_failed", e.message, e)
    }
  }

  @ReactMethod
  fun decryptMessage(channelKeyB64: String, ciphertextB64: String, promise: Promise) {
    try {
      val k = unb64(channelKeyB64)
      if (k.size != 32) {
        promise.reject("bad_channel_key", "channel key must be 32 bytes")
        return
      }
      val raw = unb64(ciphertextB64)
      if (raw.size < ivBytes + 1) {
        promise.reject("bad_ciphertext", "ciphertext too short")
        return
      }
      val iv = raw.copyOfRange(0, ivBytes)
      val ct = raw.copyOfRange(ivBytes, raw.size)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(tagBits, iv))
      val plaintext = cipher.doFinal(ct)
      promise.resolve(b64(plaintext))
    } catch (e: Throwable) {
      promise.reject("decrypt_failed", e.message, e)
    }
  }
}
