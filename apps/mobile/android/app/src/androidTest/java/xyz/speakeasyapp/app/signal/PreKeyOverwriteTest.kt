package xyz.speakeasyapp.app.signal

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.fail
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

/**
 * Proves — on real libsignal (native, so on-device only) — the root cause of the
 * "[couldn't decrypt this message] / invalid PreKey message" bubbles:
 *
 * `generatePreKeyBundle` stores its signed prekey at a FIXED id (1) and its
 * one-time prekeys at FIXED ids (1..N), and the store does INSERT OR REPLACE
 * (SqlCipherSignalProtocolStore). So when `ensureServerBinding` re-generates a
 * bundle on a re-bind, it OVERWRITES the private keys any in-flight PreKey
 * message was sealed to → that message can never decrypt.
 *
 * `overwritingPrekeyAtSameId_breaksDecryption` reproduces the bug.
 * `regeneratingAtFreshIds_preservesDecryption` proves the fix direction:
 * regenerate at NEW ids and the old keys survive to decrypt in-flight messages.
 */
@RunWith(AndroidJUnit4::class)
class PreKeyOverwriteTest {

    private fun newStore(): InMemorySignalProtocolStore =
        InMemorySignalProtocolStore(IdentityKeyPair.generate(), (1..16380).random())

    private class Sealed(
        val recipient: InMemorySignalProtocolStore,
        val senderAddr: SignalProtocolAddress,
        val ciphertext: ByteArray,
    )

    /**
     * Recipient publishes a bundle at (signedId, oneTimeId); a fresh sender
     * fetches it, establishes a session, and seals a PreKey message ("hello").
     * Returns the recipient store (still holding those prekeys) + the ciphertext.
     */
    private fun sealMessageTo(signedId: Int, oneTimeId: Int): Sealed {
        val recipient = newStore()
        val recipientAddr = SignalProtocolAddress("recipient", 1)

        val signedPair = Curve.generateKeyPair()
        val signedSig = Curve.calculateSignature(
            recipient.identityKeyPair.privateKey, signedPair.publicKey.serialize()
        )
        recipient.storeSignedPreKey(signedId, SignedPreKeyRecord(signedId, 1L, signedPair, signedSig))

        val oneTimePair = Curve.generateKeyPair()
        recipient.storePreKey(oneTimeId, PreKeyRecord(oneTimeId, oneTimePair))

        val bundle = PreKeyBundle(
            recipient.localRegistrationId, 1,
            oneTimeId, oneTimePair.publicKey,
            signedId, signedPair.publicKey, signedSig,
            recipient.identityKeyPair.publicKey,
        )

        val sender = newStore()
        val senderAddr = SignalProtocolAddress("sender", 1)
        SessionBuilder(sender, recipientAddr).process(bundle)
        val ct = SessionCipher(sender, recipientAddr).encrypt("hello".toByteArray())
        return Sealed(recipient, senderAddr, ct.serialize())
    }

    @Test
    fun overwritingPrekeyAtSameId_breaksDecryption() {
        val s = sealMessageTo(signedId = 1, oneTimeId = 1)

        // Re-enroll churn: regenerate at the SAME ids. INSERT OR REPLACE clobbers
        // the private keys the in-flight message was sealed to.
        val newSigned = Curve.generateKeyPair()
        val newSig = Curve.calculateSignature(
            s.recipient.identityKeyPair.privateKey, newSigned.publicKey.serialize()
        )
        s.recipient.storeSignedPreKey(1, SignedPreKeyRecord(1, 2L, newSigned, newSig))
        s.recipient.storePreKey(1, PreKeyRecord(1, Curve.generateKeyPair()))

        try {
            SessionCipher(s.recipient, s.senderAddr).decrypt(PreKeySignalMessage(s.ciphertext))
            fail("expected decryption to FAIL after the prekeys were overwritten")
        } catch (expected: Exception) {
            // The reproduction: libsignal no longer holds the key it was sealed to.
        }
    }

    @Test
    fun regeneratingAtFreshIds_preservesDecryption() {
        val s = sealMessageTo(signedId = 1, oneTimeId = 1)

        // The fix: regenerate at NEW ids (2). The id=1 keys the in-flight message
        // needs are untouched.
        val newSigned = Curve.generateKeyPair()
        val newSig = Curve.calculateSignature(
            s.recipient.identityKeyPair.privateKey, newSigned.publicKey.serialize()
        )
        s.recipient.storeSignedPreKey(2, SignedPreKeyRecord(2, 2L, newSigned, newSig))
        s.recipient.storePreKey(2, PreKeyRecord(2, Curve.generateKeyPair()))

        val plain = SessionCipher(s.recipient, s.senderAddr).decrypt(PreKeySignalMessage(s.ciphertext))
        assertArrayEquals("hello".toByteArray(), plain)
    }
}
