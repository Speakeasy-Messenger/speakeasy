package xyz.speakeasyapp.app.signal

import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord
import org.signal.libsignal.protocol.state.IdentityKeyStore
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SignalProtocolStore
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.impl.InMemoryKyberPreKeyStore
import java.util.UUID

/**
 * SQLCipher-backed [SignalProtocolStore]. Phase 5c.
 *
 * Backs five of the six SignalProtocolStore interfaces with SQLCipher:
 * [IdentityKeyStore], `PreKeyStore`, `SignedPreKeyStore`, `SessionStore`,
 * and (Sender Keys post-Phase 5b carry-over) `SenderKeyStore`. Only
 * `KyberPreKeyStore` is still delegated to the in-memory impl — Kyber
 * (post-quantum) is not yet exercised by either the 1:1 or group path,
 * and the in-memory store is good enough as a SignalProtocolStore-shape
 * placeholder until that work lands.
 *
 * # Identity trust model (TOFU)
 *
 * Mirrors `InMemoryIdentityKeyStore`: the first identity we see for a
 * peer is trusted; later mismatches are rejected by [isTrustedIdentity].
 * Out-of-band identity verification (safety numbers, etc.) is a Phase 6
 * UX add — `saveIdentity` returns `true` to indicate the trust set grew.
 *
 * # Storage layout
 *
 * Schema is in [xyz.speakeasyapp.app.db.Schema] (DB version 1). All
 * record bytes are libsignal's native `serialize()` blobs — opaque to us,
 * round-tripped through the constructor that takes `byte[]`.
 */
class SqlCipherSignalProtocolStore(
    private val db: SQLiteDatabase,
    private val identityKeyPair: IdentityKeyPair,
    private val registrationId: Int,
) : SignalProtocolStore {

  // Kyber prekeys: not yet exercised by the 1:1 or group path. Held in
  // memory so the SignalProtocolStore contract is satisfied.
  private val kyberPreKeyStore = InMemoryKyberPreKeyStore()

  // ---------------- IdentityKeyStore ----------------

  override fun getIdentityKeyPair(): IdentityKeyPair = identityKeyPair

  override fun getLocalRegistrationId(): Int = registrationId

  override fun saveIdentity(address: SignalProtocolAddress, identityKey: IdentityKey): Boolean {
    val existing = getIdentity(address)
    db.execSQL(
        "INSERT OR REPLACE INTO identities(name, device_id, identity_key) VALUES(?, ?, ?)",
        arrayOf<Any?>(address.name, address.deviceId, identityKey.serialize()))
    // Per the IdentityKeyStore contract: returns true iff the identity set
    // changed (new entry OR replaced a different key). Same-key re-saves
    // return false.
    return existing == null || existing != identityKey
  }

  override fun isTrustedIdentity(
      address: SignalProtocolAddress,
      identityKey: IdentityKey,
      direction: IdentityKeyStore.Direction,
  ): Boolean {
    val existing = getIdentity(address)
    return existing == null || existing == identityKey
  }

  override fun getIdentity(address: SignalProtocolAddress): IdentityKey? {
    // SQLCipher Android's `rawQuery(String, Object...)` mis-binds Int args
    // (caused 0.1.3 PRAGMA bug; same root cause silently broke session
    // lookup until 0.2.9). Use the String[] overload — it works for all
    // selection-arg types.
    db.rawQuery(
            "SELECT identity_key FROM identities WHERE name = ? AND device_id = ?",
            arrayOf(address.name, address.deviceId.toString()))
        .use { cur ->
          if (!cur.moveToFirst()) return null
          val bytes = cur.getBlob(0)
          return IdentityKey(bytes, 0)
        }
  }

  // ---------------- PreKeyStore ----------------

  override fun loadPreKey(preKeyId: Int): PreKeyRecord {
    db.rawQuery("SELECT record FROM prekeys WHERE id = ?", arrayOf(preKeyId.toString())).use { cur ->
      if (!cur.moveToFirst()) {
        throw InvalidKeyIdException("No such prekey: $preKeyId")
      }
      return PreKeyRecord(cur.getBlob(0))
    }
  }

  override fun storePreKey(preKeyId: Int, record: PreKeyRecord) {
    db.execSQL(
        "INSERT OR REPLACE INTO prekeys(id, record) VALUES(?, ?)",
        arrayOf<Any?>(preKeyId, record.serialize()))
  }

  override fun containsPreKey(preKeyId: Int): Boolean {
    db.rawQuery("SELECT 1 FROM prekeys WHERE id = ?", arrayOf(preKeyId.toString())).use { cur ->
      return cur.moveToFirst()
    }
  }

  override fun removePreKey(preKeyId: Int) {
    db.execSQL("DELETE FROM prekeys WHERE id = ?", arrayOf<Any?>(preKeyId))
  }

  // ---------------- SignedPreKeyStore ----------------

  override fun loadSignedPreKey(signedPreKeyId: Int): SignedPreKeyRecord {
    db.rawQuery(
            "SELECT record FROM signed_prekeys WHERE id = ?", arrayOf(signedPreKeyId.toString()))
        .use { cur ->
          if (!cur.moveToFirst()) {
            throw InvalidKeyIdException("No such signed prekey: $signedPreKeyId")
          }
          return SignedPreKeyRecord(cur.getBlob(0))
        }
  }

  override fun loadSignedPreKeys(): List<SignedPreKeyRecord> {
    val out = mutableListOf<SignedPreKeyRecord>()
    // Use the String[] overload with null bindArgs — see Schema.kt
    // comment about the rawQuery(String, Object...) bug with empty arrays.
    db.rawQuery("SELECT record FROM signed_prekeys", null as Array<String>?).use { cur ->
      while (cur.moveToNext()) {
        out += SignedPreKeyRecord(cur.getBlob(0))
      }
    }
    return out
  }

  override fun storeSignedPreKey(signedPreKeyId: Int, record: SignedPreKeyRecord) {
    db.execSQL(
        "INSERT OR REPLACE INTO signed_prekeys(id, record) VALUES(?, ?)",
        arrayOf<Any?>(signedPreKeyId, record.serialize()))
  }

  override fun containsSignedPreKey(signedPreKeyId: Int): Boolean {
    db.rawQuery("SELECT 1 FROM signed_prekeys WHERE id = ?", arrayOf(signedPreKeyId.toString()))
        .use { cur ->
          return cur.moveToFirst()
        }
  }

  override fun removeSignedPreKey(signedPreKeyId: Int) {
    db.execSQL("DELETE FROM signed_prekeys WHERE id = ?", arrayOf<Any?>(signedPreKeyId))
  }

  // ---------------- SessionStore ----------------

  override fun loadSession(address: SignalProtocolAddress): SessionRecord {
    db.rawQuery(
            "SELECT record FROM sessions WHERE name = ? AND device_id = ?",
            arrayOf(address.name, address.deviceId.toString()))
        .use { cur ->
          // Per contract: return a fresh empty SessionRecord rather than
          // null when no session exists yet (matches InMemorySessionStore).
          if (!cur.moveToFirst()) return SessionRecord()
          return SessionRecord(cur.getBlob(0))
        }
  }

  override fun loadExistingSessions(
      addresses: List<SignalProtocolAddress>,
  ): List<SessionRecord> {
    val out = mutableListOf<SessionRecord>()
    for (addr in addresses) {
      db.rawQuery(
              "SELECT record FROM sessions WHERE name = ? AND device_id = ?",
              arrayOf(addr.name, addr.deviceId.toString()))
          .use { cur ->
            if (!cur.moveToFirst()) {
              throw NoSessionException("no session for ${addr.name}.${addr.deviceId}")
            }
            out += SessionRecord(cur.getBlob(0))
          }
    }
    return out
  }

  override fun getSubDeviceSessions(name: String): List<Int> {
    val out = mutableListOf<Int>()
    db.rawQuery(
            // Spec convention (Signal): primary device is id 1, return only
            // the secondaries.
            "SELECT device_id FROM sessions WHERE name = ? AND device_id != 1",
            arrayOf(name))
        .use { cur ->
          while (cur.moveToNext()) out += cur.getInt(0)
        }
    return out
  }

  override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) {
    db.execSQL(
        "INSERT OR REPLACE INTO sessions(name, device_id, record) VALUES(?, ?, ?)",
        arrayOf<Any?>(address.name, address.deviceId, record.serialize()))
  }

  override fun containsSession(address: SignalProtocolAddress): Boolean {
    db.rawQuery(
            "SELECT 1 FROM sessions WHERE name = ? AND device_id = ?",
            arrayOf(address.name, address.deviceId.toString()))
        .use { cur ->
          return cur.moveToFirst()
        }
  }

  override fun deleteSession(address: SignalProtocolAddress) {
    db.execSQL(
        "DELETE FROM sessions WHERE name = ? AND device_id = ?",
        arrayOf<Any?>(address.name, address.deviceId))
  }

  override fun deleteAllSessions(name: String) {
    db.execSQL("DELETE FROM sessions WHERE name = ?", arrayOf<Any?>(name))
  }

  /**
   * Clear *everything* the store remembers about a peer — identity row +
   * all session rows. Used by [SignalProtocolModule.resetPeer] when the
   * user opts in to trust a peer's freshly-rotated identity (typical
   * after the peer reinstalls / re-enrolls). After this, the next
   * [saveIdentity] for `name` becomes a clean TOFU and the next
   * [initiateSession] gets a clean session.
   *
   * Mirrors `deleteAllSessions(name)` semantics — both are key-namespaced
   * by the peer userId, ignoring deviceId, since we only run a single
   * deviceId per peer in the 1:1 path today.
   */
  fun clearPeerIdentity(name: String) {
    db.execSQL("DELETE FROM identities WHERE name = ?", arrayOf<Any?>(name))
    db.execSQL("DELETE FROM sessions WHERE name = ?", arrayOf<Any?>(name))
  }

  // ---------------- KyberPreKeyStore (delegated, Phase 5b carry-over) ----------------

  override fun loadKyberPreKey(kyberPreKeyId: Int) = kyberPreKeyStore.loadKyberPreKey(kyberPreKeyId)
  override fun loadKyberPreKeys() = kyberPreKeyStore.loadKyberPreKeys()
  override fun storeKyberPreKey(
      kyberPreKeyId: Int,
      record: org.signal.libsignal.protocol.state.KyberPreKeyRecord,
  ) = kyberPreKeyStore.storeKyberPreKey(kyberPreKeyId, record)
  override fun containsKyberPreKey(kyberPreKeyId: Int) =
      kyberPreKeyStore.containsKyberPreKey(kyberPreKeyId)
  override fun markKyberPreKeyUsed(kyberPreKeyId: Int) =
      kyberPreKeyStore.markKyberPreKeyUsed(kyberPreKeyId)

  // ---------------- SenderKeyStore (SQLCipher-backed) ----------------

  override fun storeSenderKey(
      sender: SignalProtocolAddress,
      distributionId: UUID,
      record: SenderKeyRecord,
  ) {
    db.execSQL(
        "INSERT OR REPLACE INTO sender_keys(name, device_id, distribution_id, record) " +
            "VALUES(?, ?, ?, ?)",
        arrayOf<Any?>(sender.name, sender.deviceId, distributionId.toString(), record.serialize()))
  }

  override fun loadSenderKey(
      sender: SignalProtocolAddress,
      distributionId: UUID,
  ): SenderKeyRecord? {
    db.rawQuery(
            "SELECT record FROM sender_keys WHERE name = ? AND device_id = ? AND distribution_id = ?",
            arrayOf(sender.name, sender.deviceId.toString(), distributionId.toString()))
        .use { cur ->
          if (!cur.moveToFirst()) return null
          return SenderKeyRecord(cur.getBlob(0))
        }
  }

  // ---------------- Convenience: persist initial identity to DB ----------------

  /**
   * Write the local identity to the `identity` singleton row. Call once
   * after generating a fresh identity, so subsequent app starts can
   * reconstruct the store from disk via [loadFromDb].
   */
  fun persistLocalIdentity() {
    db.execSQL(
        "INSERT OR REPLACE INTO identity(id, identity_key_pair, registration_id) VALUES(0, ?, ?)",
        arrayOf<Any?>(identityKeyPair.serialize(), registrationId))
  }

  companion object {
    /**
     * Reconstruct the store from disk. Returns null if no identity row
     * exists yet — caller should generate one, construct the store, and
     * call [persistLocalIdentity].
     */
    fun loadFromDb(db: SQLiteDatabase): SqlCipherSignalProtocolStore? {
      // String[] overload with null bindArgs — see Schema.kt note about
      // the rawQuery(String, Object...) bug.
      db.rawQuery(
              "SELECT identity_key_pair, registration_id FROM identity WHERE id = 0",
              null as Array<String>?,
          )
          .use { cur ->
            if (!cur.moveToFirst()) return null
            val ikp = IdentityKeyPair(cur.getBlob(0))
            val regId = cur.getInt(1)
            return SqlCipherSignalProtocolStore(db, ikp, regId)
          }
    }
  }
}
