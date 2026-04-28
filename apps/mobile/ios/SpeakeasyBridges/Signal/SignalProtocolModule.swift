//
//  SignalProtocolModule.swift
//  Speakeasy
//
//  Phase 5b iOS — RN bridge for the 1:1 Signal Protocol path. Mirrors
//  apps/mobile/android/.../signal/SignalProtocolModule.kt
//
//  # libsignal-client iOS API NOTE
//
//  The Swift API uses free functions (`processPreKeyBundle`,
//  `signalEncrypt`, `signalDecryptPreKey`, `signalDecrypt`) instead of
//  the `SessionBuilder` / `SessionCipher` classes the Java/Kotlin API
//  exposes. Each takes the relevant store protocols as parameters.
//  Anything marked `// libsignal:` is a best-guess based on the
//  reference docs; the exact signatures may need a one-pass fix once
//  Mac access lands.
//
//  # Wire format (matches Android exactly)
//
//  encrypt: returns base64( typeByte || libsignalSerializedMessage )
//    typeByte 0x03 = PreKeySignalMessage (first message after handshake)
//    typeByte 0x02 = SignalMessage       (subsequent messages)
//
//  decrypt: takes base64( typeByte || body ), dispatches based on the byte.
//

import Foundation
import LibSignalClient

@objc(SignalProtocolModule)
class SignalProtocolModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    private let deviceId: UInt32 = 1
    private let context = NullContext()

    // MARK: - generateIdentityKey

    @objc(generateIdentityKey:rejecter:)
    func generateIdentityKey(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            // Don't clobber a persisted identity — restore + return its
            // public key instead of minting a fresh one.
            if SpeakeasySignalStore.initializeFromDb() {
                let store = try SpeakeasySignalStore.require()
                let ikp = try store.identityKeyPair(context: context)
                resolve(Data(ikp.publicKey.serialize()).base64EncodedString())
                return
            }
            let ikp = IdentityKeyPair.generate()
            // Match Android's range: 1..16380 (libsignal's reserved space).
            let regId = UInt32.random(in: 1...16380)
            try SpeakeasySignalStore.initialize(identityKeyPair: ikp, registrationId: regId)
            resolve(Data(ikp.publicKey.serialize()).base64EncodedString())
        } catch {
            reject("identity_key_failed", error.localizedDescription, error)
        }
    }

    // MARK: - generatePreKeyBundle

    @objc(generatePreKeyBundle:signedPreKeyId:oneTimePreKeyCount:resolver:rejecter:)
    func generatePreKeyBundle(_ registrationIdNum: NSNumber,
                              signedPreKeyId: NSNumber,
                              oneTimePreKeyCount: NSNumber,
                              resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            ensureRestored()
            let store = try SpeakeasySignalStore.require()
            let ikp = try store.identityKeyPair(context: context)

            // Signed prekey — long-lived, server-stored, signed by identity.
            let signedKeyId = UInt32(truncating: signedPreKeyId)
            let signedPreKeyPair = PrivateKey.generate()
            let signedPreKeyPub = signedPreKeyPair.publicKey
            let signedPreKeySig = ikp.privateKey.generateSignature(
                message: signedPreKeyPub.serialize()
            )
            let signedRecord = try SignedPreKeyRecord(
                id: signedKeyId,
                timestamp: UInt64(Date().timeIntervalSince1970 * 1000),
                privateKey: signedPreKeyPair,
                signature: Data(signedPreKeySig)
            )
            try store.storeSignedPreKey(signedRecord, id: signedKeyId, context: context)

            // One-time prekeys.
            var preKeysOut: [[String: Any]] = []
            let count = Int(truncating: oneTimePreKeyCount)
            for i in 0..<count {
                let pkId = UInt32(i + 1)
                let pkPair = PrivateKey.generate()
                let pkRec = try PreKeyRecord(id: pkId, privateKey: pkPair)
                try store.storePreKey(pkRec, id: pkId, context: context)
                preKeysOut.append([
                    "id": Int(pkId),
                    "key": Data(pkPair.publicKey.serialize()).base64EncodedString()
                ])
            }

            resolve([
                "registrationId":     Int(truncating: registrationIdNum),
                "signedPreKeyId":     Int(signedKeyId),
                "signedPreKey":       Data(signedPreKeyPub.serialize()).base64EncodedString(),
                "signedPreKeySig":    Data(signedPreKeySig).base64EncodedString(),
                "preKeys":            preKeysOut,
                "identityPublicKey":  Data(ikp.publicKey.serialize()).base64EncodedString()
            ])
        } catch {
            reject("prekey_bundle_failed", error.localizedDescription, error)
        }
    }

    // MARK: - initiateSession

    @objc(initiateSession:peerBundle:resolver:rejecter:)
    func initiateSession(_ peerUserId: NSString,
                         peerBundle: NSDictionary,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            ensureRestored()
            let store = try SpeakeasySignalStore.require()
            let regId = UInt32(truncating: peerBundle["registrationId"] as? NSNumber ?? 0)
            let signedKeyId = UInt32(truncating: peerBundle["signedPreKeyId"] as? NSNumber ?? 0)
            guard
                let signedKeyB64 = peerBundle["signedPreKey"] as? String,
                let signedSigB64 = peerBundle["signedPreKeySig"] as? String,
                let identityB64 = peerBundle["identityPublicKey"] as? String,
                let preKeys = peerBundle["preKeys"] as? [[String: Any]],
                let firstPK = preKeys.first,
                let firstPKKeyB64 = firstPK["key"] as? String,
                let firstPKIdNum = firstPK["id"] as? NSNumber
            else {
                reject("session_init_failed", "malformed peer bundle", nil)
                return
            }
            let identityKey = try IdentityKey(bytes: Array(b64(identityB64)))
            let signedPreKey = try PublicKey(Array(b64(signedKeyB64)))
            let oneTimePreKey = try PublicKey(Array(b64(firstPKKeyB64)))

            let bundle = try PreKeyBundle(
                registrationId: regId,
                deviceId: deviceId,
                prekeyId: UInt32(truncating: firstPKIdNum),
                prekey: oneTimePreKey,
                signedPrekeyId: signedKeyId,
                signedPrekey: signedPreKey,
                signedPrekeySignature: Array(b64(signedSigB64)),
                identity: identityKey
            )

            let peerAddr = try ProtocolAddress(name: peerUserId as String, deviceId: deviceId)
            // libsignal: free function. Persists session into the store.
            try processPreKeyBundle(
                bundle,
                for: peerAddr,
                sessionStore: store,
                identityStore: store,
                context: context
            )
            resolve(NSNull())
        } catch SignalError.untrustedIdentity(_) {
            reject("untrusted_identity", "peer's identity key changed", nil)
        } catch {
            reject("session_init_failed", error.localizedDescription, error)
        }
    }

    // MARK: - encrypt / decrypt

    @objc(encrypt:plaintext:resolver:rejecter:)
    func encrypt(_ peerUserId: NSString,
                 plaintext plaintextB64: NSString,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            ensureRestored()
            let store = try SpeakeasySignalStore.require()
            let peerAddr = try ProtocolAddress(name: peerUserId as String, deviceId: deviceId)
            let plaintext = b64(plaintextB64 as String)

            // libsignal: free-function encrypt. Returns CiphertextMessage
            // which has `.messageType` (PreKey or Whisper) + `.serialize()`.
            let msg = try signalEncrypt(
                message: plaintext,
                for: peerAddr,
                sessionStore: store,
                identityStore: store,
                context: context
            )
            let typeByte: UInt8 = (msg.messageType == .preKey) ? 0x03 : 0x02
            var out = Data()
            out.append(typeByte)
            out.append(Data(msg.serialize()))
            resolve(out.base64EncodedString())
        } catch {
            reject("encrypt_failed", error.localizedDescription, error)
        }
    }

    @objc(decrypt:ciphertext:resolver:rejecter:)
    func decrypt(_ peerUserId: NSString,
                 ciphertext ciphertextB64: NSString,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            ensureRestored()
            let store = try SpeakeasySignalStore.require()
            let peerAddr = try ProtocolAddress(name: peerUserId as String, deviceId: deviceId)
            let raw = b64(ciphertextB64 as String)
            guard raw.count > 1 else {
                reject("decrypt_failed", "empty ciphertext", nil)
                return
            }
            let typeByte = raw[0]
            let body = Array(raw.suffix(from: 1))

            let plaintext: [UInt8]
            switch typeByte {
            case 0x03:
                let msg = try PreKeySignalMessage(bytes: body)
                // libsignal: free-function decrypt for PreKey message.
                plaintext = try signalDecryptPreKey(
                    message: msg,
                    from: peerAddr,
                    sessionStore: store,
                    identityStore: store,
                    preKeyStore: store,
                    signedPreKeyStore: store,
                    kyberPreKeyStore: store,
                    context: context
                )
            case 0x02:
                let msg = try SignalMessage(bytes: body)
                plaintext = try signalDecrypt(
                    message: msg,
                    from: peerAddr,
                    sessionStore: store,
                    identityStore: store,
                    context: context
                )
            default:
                reject("decrypt_failed", "unknown ciphertext type byte 0x\(String(typeByte, radix: 16))", nil)
                return
            }
            resolve(Data(plaintext).base64EncodedString())
        } catch SignalError.untrustedIdentity(_) {
            reject("untrusted_identity", "peer's identity key changed", nil)
        } catch {
            reject("decrypt_failed", error.localizedDescription, error)
        }
    }

    // MARK: - Helpers

    /// Lazy on-disk restore, mirrors Android's ensureRestored().
    private func ensureRestored() {
        if !SpeakeasySignalStore.isInitialized {
            _ = SpeakeasySignalStore.initializeFromDb()
        }
    }

    private func b64(_ s: String) -> Data {
        return Data(base64Encoded: s) ?? Data()
    }
}
