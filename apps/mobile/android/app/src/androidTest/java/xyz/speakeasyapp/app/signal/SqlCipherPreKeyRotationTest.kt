package xyz.speakeasyapp.app.signal

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import xyz.speakeasyapp.app.db.Schema
import java.io.File

/**
 * Verifies the fix on the REAL [SqlCipherSignalProtocolStore] (on-device):
 * `nextPreKeyId`/`nextSignedPreKeyId` return MAX(id)+1, so a re-generated bundle
 * lands on fresh ids and never INSERT-OR-REPLACEs over the keys an in-flight
 * PreKey message was sealed to. Uses a throwaway SQLCipher DB — never the app's
 * real signal store.
 */
@RunWith(AndroidJUnit4::class)
class SqlCipherPreKeyRotationTest {

    private fun freshStore(): SqlCipherSignalProtocolStore {
        System.loadLibrary("sqlcipher")
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val dbFile = File(ctx.cacheDir, "test_signal_${System.nanoTime()}.db")
        if (dbFile.exists()) dbFile.delete()
        val db = SQLiteDatabase.openOrCreateDatabase(
            dbFile, "test-passphrase".toByteArray(), null, null, null
        )
        Schema.applyMigrations(db)
        return SqlCipherSignalProtocolStore(db, IdentityKeyPair.generate(), (1..16380).random())
    }

    @Test
    fun nextIds_incrementInsteadOfReusing() {
        val store = freshStore()
        assertEquals(1, store.nextSignedPreKeyId())
        assertEquals(1, store.nextPreKeyId())

        val kp = Curve.generateKeyPair()
        val sig = Curve.calculateSignature(store.identityKeyPair.privateKey, kp.publicKey.serialize())
        store.storeSignedPreKey(1, SignedPreKeyRecord(1, 1L, kp, sig))
        store.storePreKey(1, PreKeyRecord(1, Curve.generateKeyPair()))

        // A regenerated bundle lands on a FRESH id (2), never clobbering id=1.
        assertEquals(2, store.nextSignedPreKeyId())
        assertEquals(2, store.nextPreKeyId())
    }

    @Test
    fun regeneratingBundleAtNextIds_keepsInFlightMessageDecryptable() {
        val recipient = freshStore()
        val recipientAddr = SignalProtocolAddress("recipient", 1)

        // Bundle 1, published at the store's next ids (the fix path).
        val signedId1 = recipient.nextSignedPreKeyId()
        val signed1 = Curve.generateKeyPair()
        val sig1 = Curve.calculateSignature(recipient.identityKeyPair.privateKey, signed1.publicKey.serialize())
        recipient.storeSignedPreKey(signedId1, SignedPreKeyRecord(signedId1, 1L, signed1, sig1))
        val oneTimeId1 = recipient.nextPreKeyId()
        val oneTime1 = Curve.generateKeyPair()
        recipient.storePreKey(oneTimeId1, PreKeyRecord(oneTimeId1, oneTime1))

        val bundle1 = PreKeyBundle(
            recipient.localRegistrationId, 1,
            oneTimeId1, oneTime1.publicKey,
            signedId1, signed1.publicKey, sig1,
            recipient.identityKeyPair.publicKey,
        )

        // Sender seals a PreKey message to bundle 1.
        val sender = InMemorySignalProtocolStore(IdentityKeyPair.generate(), (1..16380).random())
        val senderAddr = SignalProtocolAddress("sender", 1)
        SessionBuilder(sender, recipientAddr).process(bundle1)
        val ciphertext = SessionCipher(sender, recipientAddr).encrypt("hello".toByteArray()).serialize()

        // Re-bind churn: regenerate at the NEXT ids (the fix). id=1 keys survive.
        val signedId2 = recipient.nextSignedPreKeyId()
        assertEquals(signedId1 + 1, signedId2)
        val signed2 = Curve.generateKeyPair()
        val sig2 = Curve.calculateSignature(recipient.identityKeyPair.privateKey, signed2.publicKey.serialize())
        recipient.storeSignedPreKey(signedId2, SignedPreKeyRecord(signedId2, 2L, signed2, sig2))
        val oneTimeId2 = recipient.nextPreKeyId()
        recipient.storePreKey(oneTimeId2, PreKeyRecord(oneTimeId2, Curve.generateKeyPair()))

        // The message sealed to bundle 1 STILL decrypts (old keys weren't clobbered).
        val plain = SessionCipher(recipient, senderAddr).decrypt(PreKeySignalMessage(ciphertext))
        assertArrayEquals("hello".toByteArray(), plain)
    }
}
