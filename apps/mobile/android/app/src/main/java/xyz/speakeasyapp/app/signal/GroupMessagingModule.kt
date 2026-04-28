package xyz.speakeasyapp.app.signal

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.groups.GroupCipher
import org.signal.libsignal.protocol.groups.GroupSessionBuilder
import org.signal.libsignal.protocol.message.SenderKeyDistributionMessage
import java.util.UUID

/**
 * RN bridge for Signal Sender Keys (group messaging).
 *
 * # Mental model
 *
 * libsignal's group session is identified by a `distributionId` UUID per
 * (sender, group). The flow:
 *
 *   1. **Sender** creates a SenderKey for `(self_address, distributionId)`
 *      via [createSenderKeyDistribution]. This both writes the local
 *      record AND emits a `SenderKeyDistributionMessage` (SKDM) the
 *      sender must fan out to every recipient via 1:1 Signal sessions.
 *
 *   2. **Recipients** call [processSenderKeyDistribution] with the
 *      sender's SKDM bytes. libsignal stores a recipient
 *      `SenderKeyRecord` keyed on `(sender_address, distributionId)`.
 *
 *   3. **Sender** calls [encryptForGroup] to produce a single ciphertext
 *      that the server can fan out to all members. The distributionId is
 *      embedded in the wire-level `SenderKeyMessage` envelope.
 *
 *   4. **Recipients** call [decryptFromGroupMember] with the
 *      `senderUserId` and ciphertext. libsignal extracts the
 *      distributionId from the message envelope and looks up the
 *      stored record.
 *
 * # Persistence
 *
 * Phase 5c carry-over: `SqlCipherSignalProtocolStore` now backs the
 * `SenderKeyStore` interface with SQLCipher (table `sender_keys`).
 * Sender + recipient state survives cold starts.
 *
 * # Wire format
 *
 * SKDM bytes and ciphertext bytes both cross the bridge as base64
 * strings (RN limitation). The native `SenderKeyDistributionMessage`
 * and `SenderKeyMessage` formats are libsignal-defined; nothing to
 * version on top.
 *
 * # JS-side distributionId allocation
 *
 * The bridge is intentionally agnostic about how distributionIds map to
 * group IDs — JS owns that mapping (so the same group can rotate its
 * distributionId without a native API change). Convention:
 * **one distributionId per (local-sender, group)**, allocated as
 * `UUID.v4()` on the device's first send to that group, persisted in JS
 * (Zustand → AsyncStorage / SQLCipher when conversation persistence
 * lands).
 *
 * # Errors
 *
 * Reject codes mirror the JS [GroupMessagingClientErrorReason]:
 *   - `no_session` — receiver got an SKDM-less message before
 *     `processSenderKeyDistribution`
 *   - `duplicate_message` — replay of a counter we've already consumed
 *   - `invalid_message` — corrupted bytes
 *   - `legacy_message` — older protocol version we no longer support
 *   - `bad_distribution_id` — distributionId string isn't a valid UUID
 *   - `unknown_error` — everything else
 */
class GroupMessagingModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "GroupMessaging"

  // Default device id; multi-device fan-out is server-side only in Phase 4.
  private val deviceId: Int = 1

  private fun b64(bytes: ByteArray): String =
      Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

  /**
   * Create a fresh SenderKey for the local user in the named group.
   * Returns the SKDM bytes (base64) — caller must fan-out to every
   * recipient via 1:1 Signal sessions before the first
   * `encryptForGroup` send is delivered.
   */
  @ReactMethod
  fun createSenderKeyDistribution(distributionIdStr: String, promise: Promise) {
    try {
      val store = SpeakeasySignalStore.requireInitialized()
      val distributionId =
          try {
            UUID.fromString(distributionIdStr)
          } catch (e: IllegalArgumentException) {
            promise.reject("bad_distribution_id", e.message)
            return
          }
      // Self-address: registrationId-derived "name" is a libsignal
      // convention only; we use the user-id-equivalent string the
      // JS layer already passes around. Since we're addressing OURSELVES,
      // we can use any stable string — pass the local identity public key
      // as a deterministic, unique sender name. Recipients address us by
      // the same "name" they pass to processSenderKeyDistribution.
      val selfName = b64(store.identityKeyPair.publicKey.serialize())
      val selfAddress = SignalProtocolAddress(selfName, deviceId)
      val builder = GroupSessionBuilder(store)
      val skdm = builder.create(selfAddress, distributionId)
      promise.resolve(b64(skdm.serialize()))
    } catch (e: Throwable) {
      promise.reject("unknown_error", e.message, e)
    }
  }

  /**
   * Process an SKDM received from a peer (over a 1:1 Signal channel,
   * decrypted by `SignalProtocolModule.decrypt` first). The peer's
   * SenderKey gets stored locally so we can decrypt their next group
   * message.
   */
  @ReactMethod
  fun processSenderKeyDistribution(
      senderUserId: String,
      skdmBytesB64: String,
      promise: Promise,
  ) {
    try {
      val store = SpeakeasySignalStore.requireInitialized()
      val skdm = SenderKeyDistributionMessage(unb64(skdmBytesB64))
      val builder = GroupSessionBuilder(store)
      builder.process(SignalProtocolAddress(senderUserId, deviceId), skdm)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("unknown_error", e.message, e)
    }
  }

  /**
   * Encrypt for the group identified by [distributionIdStr]. Returns the
   * raw `SenderKeyMessage` bytes (base64) — the server fan-out delivers
   * this single ciphertext to every recipient unchanged.
   */
  @ReactMethod
  fun encryptForGroup(
      distributionIdStr: String,
      plaintextB64: String,
      promise: Promise,
  ) {
    try {
      val store = SpeakeasySignalStore.requireInitialized()
      val distributionId =
          try {
            UUID.fromString(distributionIdStr)
          } catch (e: IllegalArgumentException) {
            promise.reject("bad_distribution_id", e.message)
            return
          }
      val selfName = b64(store.identityKeyPair.publicKey.serialize())
      val cipher = GroupCipher(store, SignalProtocolAddress(selfName, deviceId))
      val msg = cipher.encrypt(distributionId, unb64(plaintextB64))
      promise.resolve(b64(msg.serialize()))
    } catch (e: org.signal.libsignal.protocol.NoSessionException) {
      promise.reject("no_session", e.message, e)
    } catch (e: Throwable) {
      promise.reject("unknown_error", e.message, e)
    }
  }

  /** Decrypt a group message authored by [senderUserId]. */
  @ReactMethod
  fun decryptFromGroupMember(
      senderUserId: String,
      ciphertextB64: String,
      promise: Promise,
  ) {
    try {
      val store = SpeakeasySignalStore.requireInitialized()
      val cipher = GroupCipher(store, SignalProtocolAddress(senderUserId, deviceId))
      val plaintext = cipher.decrypt(unb64(ciphertextB64))
      promise.resolve(b64(plaintext))
    } catch (e: org.signal.libsignal.protocol.NoSessionException) {
      promise.reject("no_session", e.message, e)
    } catch (e: org.signal.libsignal.protocol.DuplicateMessageException) {
      promise.reject("duplicate_message", e.message, e)
    } catch (e: org.signal.libsignal.protocol.LegacyMessageException) {
      promise.reject("legacy_message", e.message, e)
    } catch (e: org.signal.libsignal.protocol.InvalidMessageException) {
      promise.reject("invalid_message", e.message, e)
    } catch (e: Throwable) {
      promise.reject("unknown_error", e.message, e)
    }
  }
}
