package xyz.speakeasyapp.app.signal

import android.content.Context
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.state.SignalProtocolStore
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import xyz.speakeasyapp.app.db.SpeakeasyDb

/**
 * Singleton holder for the active `SignalProtocolStore`.
 *
 * # Phase 5c: SQLCipher-backed by default
 *
 * On first init the store is reconstructed from disk if a previous
 * identity exists ([SqlCipherSignalProtocolStore.loadFromDb]). On a fresh
 * install, the caller passes a freshly-generated identity to [initialize]
 * which writes it to the encrypted DB.
 *
 * # Test / dev fallback
 *
 * [initializeInMemory] keeps the old behaviour for unit-style harnesses
 * that don't have a `Context` available.
 */
object SpeakeasySignalStore {
  @Volatile private var instance: SignalProtocolStore? = null

  /**
   * Phase 5c: persistent. The DB call ladder is open() → load identity row.
   *
   * Returns `false` in two distinct "not loaded yet" cases:
   *   - DB exists but no identity row yet (fresh install post-enrollment).
   *   - Vouchflow not yet enrolled — DB can't even open without a
   *     `cachedDeviceToken` ([SpeakeasyDb.NotEnrolledException]).
   *
   * Both cases mean "JS layer should mint a fresh identity and call
   * [initialize]." [initialize] requires the deviceToken be present, so
   * the JS layer must run `vouchflow.verify` first.
   */
  fun initializeFromDb(context: Context): Boolean {
    val db =
        try {
          SpeakeasyDb.open(context)
        } catch (_: SpeakeasyDb.NotEnrolledException) {
          return false
        }
    val loaded = SqlCipherSignalProtocolStore.loadFromDb(db) ?: return false
    instance = loaded
    return true
  }

  /** Phase 5c: persistent — used right after generating a fresh identity. */
  fun initialize(context: Context, identityKeyPair: IdentityKeyPair, registrationId: Int) {
    val db = SpeakeasyDb.open(context)
    val store = SqlCipherSignalProtocolStore(db, identityKeyPair, registrationId)
    store.persistLocalIdentity()
    instance = store
  }

  /** Phase 5b legacy: kept for harnesses without an Android Context. */
  fun initializeInMemory(identityKeyPair: IdentityKeyPair, registrationId: Int) {
    instance = InMemorySignalProtocolStore(identityKeyPair, registrationId)
  }

  fun requireInitialized(): SignalProtocolStore =
      instance
          ?: throw IllegalStateException(
              "SpeakeasySignalStore not initialized — call generateIdentityKey first")

  fun isInitialized(): Boolean = instance != null

  /** Drop in-memory handle. The on-disk DB is left intact. */
  fun reset() {
    instance = null
  }
}
