package xyz.speakeasyapp.app.signal

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import xyz.speakeasyapp.app.db.SpeakeasyDb
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.UntrustedIdentityException
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord

/**
 * RN bridge for the Signal Protocol (`org.signal:libsignal-android`).
 *
 * Phase 5b: covers the 1:1 path — generateIdentityKey, generatePreKeyBundle,
 * initiateSession, encrypt, decrypt. Sender Keys for groups
 * (`encryptForGroup`/`decryptFromGroupMember`) are deferred to the next
 * sweep — see spec §11 Phase 5b carry-over.
 *
 * Storage: Phase 5c swaps the in-memory `InMemorySignalProtocolStore` for
 * a SQLCipher-backed [SqlCipherSignalProtocolStore] keyed by an Android
 * Keystore-wrapped passphrase (see `SpeakeasyDb` for the deviation note vs
 * the spec's "Vouchflow device key" wording). The first call into any
 * bridge method auto-restores from the encrypted DB if an identity row
 * already exists, so cold starts no longer require re-enrollment.
 *
 * Wire format:
 *   - All bytes cross the bridge as base64 strings (RN bridge limitation).
 *   - encrypt/decrypt prefix the ciphertext with a 1-byte type marker so
 *     the recipient knows which libsignal message class to decode:
 *       0x03 = PreKeySignalMessage  (first message after initiateSession)
 *       0x02 = SignalMessage         (subsequent messages)
 *
 * Errors: rejected with code = a stable string the JS layer maps to
 * `SignalClientErrorReason`. Every code is documented at the JS interface.
 */
class SignalProtocolModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SignalProtocol"

  // Default device id; multi-device fan-out is server-side only in Phase 4.
  private val deviceId: Int = 1

  private fun b64(bytes: ByteArray): String =
      Base64.encodeToString(bytes, Base64.NO_WRAP)

  private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

  /**
   * Lazily restore the persistent store from disk on first use. No-op if
   * the store is already initialized (post-restore or post-generate). Safe
   * to call from any bridge method.
   */
  private fun ensureRestored() {
    if (!SpeakeasySignalStore.isInitialized()) {
      SpeakeasySignalStore.initializeFromDb(reactContext)
    }
  }

  @ReactMethod
  fun generateIdentityKey(promise: Promise) {
    try {
      // Phase 5c: don't clobber an already-persisted identity. If one is on
      // disk, restore + return its public key instead of minting a fresh one.
      if (SpeakeasySignalStore.initializeFromDb(reactContext)) {
        val ikp = SpeakeasySignalStore.requireInitialized().identityKeyPair
        promise.resolve(b64(ikp.publicKey.serialize()))
        return
      }
      val identityKeyPair = IdentityKeyPair.generate()
      val registrationId = (1..16380).random()
      SpeakeasySignalStore.initialize(reactContext, identityKeyPair, registrationId)
      promise.resolve(b64(identityKeyPair.publicKey.serialize()))
    } catch (e: Throwable) {
      promise.reject("identity_key_failed", e.message, e)
    }
  }

  @ReactMethod
  fun generatePreKeyBundle(
      registrationId: Int,
      signedPreKeyId: Int,
      oneTimePreKeyCount: Int,
      promise: Promise,
  ) {
    try {
      ensureRestored()
      val store = SpeakeasySignalStore.requireInitialized()
      val identityKeyPair = store.identityKeyPair

      // Signed prekey — long-lived, server-stored, signed by identity.
      val signedPreKeyPair = Curve.generateKeyPair()
      val signedPreKeySig =
          Curve.calculateSignature(
              identityKeyPair.privateKey, signedPreKeyPair.publicKey.serialize())
      val signedRecord =
          SignedPreKeyRecord(
              signedPreKeyId,
              System.currentTimeMillis(),
              signedPreKeyPair,
              signedPreKeySig)
      store.storeSignedPreKey(signedPreKeyId, signedRecord)

      // One-time prekeys — bucket the server hands out to peers establishing
      // new sessions. Each gets consumed once (server side).
      val preKeysArr = Arguments.createArray()
      for (i in 0 until oneTimePreKeyCount) {
        val pkId = i + 1
        val pkPair = Curve.generateKeyPair()
        store.storePreKey(pkId, PreKeyRecord(pkId, pkPair))
        preKeysArr.pushMap(
            Arguments.createMap().apply {
              putInt("id", pkId)
              putString("key", b64(pkPair.publicKey.serialize()))
            })
      }

      promise.resolve(
          Arguments.createMap().apply {
            putInt("registrationId", registrationId)
            putInt("signedPreKeyId", signedPreKeyId)
            putString("signedPreKey", b64(signedPreKeyPair.publicKey.serialize()))
            putString("signedPreKeySig", b64(signedPreKeySig))
            putArray("preKeys", preKeysArr)
            // Identity public key — server stores per-user.
            putString("identityPublicKey", b64(identityKeyPair.publicKey.serialize()))
          })
    } catch (e: Throwable) {
      promise.reject("prekey_bundle_failed", e.message, e)
    }
  }

  @ReactMethod
  fun initiateSession(peerUserId: String, peerBundle: ReadableMap, promise: Promise) {
    try {
      ensureRestored()
      val store = SpeakeasySignalStore.requireInitialized()

      val regId = peerBundle.getInt("registrationId")
      val signedPreKeyId = peerBundle.getInt("signedPreKeyId")
      val signedPreKeyBytes = unb64(peerBundle.getString("signedPreKey")!!)
      val signedPreKeySig = unb64(peerBundle.getString("signedPreKeySig")!!)
      val identityPublicKeyBytes = unb64(peerBundle.getString("identityPublicKey")!!)

      // Pick the first one-time prekey the server returned. (Server's
      // `/v1/prekeys/bundle` already consumed exactly one for us.)
      val preKeysArr = peerBundle.getArray("preKeys")
      if (preKeysArr == null || preKeysArr.size() == 0) {
        promise.reject("no_prekey", "peer bundle missing one-time prekey")
        return
      }
      val firstPreKey = preKeysArr.getMap(0)
      val preKeyId = firstPreKey.getInt("id")
      val preKeyBytes = unb64(firstPreKey.getString("key")!!)

      val identityKey = IdentityKey(identityPublicKeyBytes, 0)
      val signedPreKeyPub = Curve.decodePoint(signedPreKeyBytes, 0)
      val preKeyPub: ECPublicKey = Curve.decodePoint(preKeyBytes, 0)

      val bundle =
          PreKeyBundle(
              regId,
              deviceId,
              preKeyId,
              preKeyPub,
              signedPreKeyId,
              signedPreKeyPub,
              signedPreKeySig,
              identityKey,
          )

      val peerAddress = SignalProtocolAddress(peerUserId, deviceId)
      val builder = SessionBuilder(store, peerAddress)
      builder.process(bundle)
      promise.resolve(null)
    } catch (e: UntrustedIdentityException) {
      promise.reject("untrusted_identity", e.message, e)
    } catch (e: Throwable) {
      promise.reject("session_init_failed", e.message, e)
    }
  }

  @ReactMethod
  fun encrypt(peerUserId: String, plaintextB64: String, promise: Promise) {
    try {
      ensureRestored()
      val store = SpeakeasySignalStore.requireInitialized()
      val plaintext = unb64(plaintextB64)
      val cipher = SessionCipher(store, SignalProtocolAddress(peerUserId, deviceId))
      val msg = cipher.encrypt(plaintext)
      // Prefix with type byte so the recipient can dispatch decrypt cleanly.
      val typeByte = msg.type.toByte()
      val out = ByteArray(1 + msg.serialize().size)
      out[0] = typeByte
      System.arraycopy(msg.serialize(), 0, out, 1, msg.serialize().size)
      promise.resolve(b64(out))
    } catch (e: Throwable) {
      promise.reject("encrypt_failed", e.message, e)
    }
  }

  @ReactMethod
  fun decrypt(peerUserId: String, ciphertextB64: String, promise: Promise) {
    try {
      ensureRestored()
      val store = SpeakeasySignalStore.requireInitialized()
      val raw = unb64(ciphertextB64)
      if (raw.isEmpty()) {
        promise.reject("decrypt_failed", "empty ciphertext")
        return
      }
      // Idempotent decrypt: the headless push handler and the in-app WS
      // path both decrypt the same ciphertext; the ratchet may advance
      // only once. See DecryptCache.
      val plaintext =
          DecryptCache.decryptCached(SpeakeasyDb.open(reactContext), raw) {
            val typeByte = raw[0].toInt() and 0xFF
            val body = raw.copyOfRange(1, raw.size)
            val cipher = SessionCipher(store, SignalProtocolAddress(peerUserId, deviceId))
            when (typeByte) {
              3 -> cipher.decrypt(PreKeySignalMessage(body))
              2 -> cipher.decrypt(SignalMessage(body))
              else ->
                  throw IllegalArgumentException("unknown ciphertext type byte $typeByte")
            }
          }
      promise.resolve(b64(plaintext))
    } catch (e: UntrustedIdentityException) {
      promise.reject("untrusted_identity", e.message, e)
    } catch (e: Throwable) {
      promise.reject("decrypt_failed", e.message, e)
    }
  }

  /**
   * Clear all stored state about a peer — their identity key + every
   * session record. Used to recover from `UntrustedIdentityException`
   * when the user opts in to trust a peer's freshly-rotated identity
   * (typical after the peer reinstalls / re-enrolls and gets a new
   * Signal identity key).
   *
   * After this returns, the next `initiateSession(peerUserId, …)`
   * fetches the peer's current PreKey bundle and saves the new identity
   * via TOFU — exactly as if we had never communicated with them.
   *
   * The caller is responsible for also dropping any in-process session
   * cache (see `crypto/session.ts:initiatedPeers`).
   */
  @ReactMethod
  fun resetPeer(peerUserId: String, promise: Promise) {
    try {
      ensureRestored()
      val store = SpeakeasySignalStore.requireInitialized()
      // SpeakeasySignalStore returns the SignalProtocolStore interface;
      // clearPeerIdentity is a SqlCipher-specific helper. There's only
      // one impl in production (the InMemoryStore is test-only).
      (store as SqlCipherSignalProtocolStore).clearPeerIdentity(peerUserId)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("reset_peer_failed", e.message, e)
    }
  }
}
