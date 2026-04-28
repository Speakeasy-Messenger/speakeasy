//
//  ChannelKeyModule.swift
//  Speakeasy
//
//  Phase 5b iOS — RN bridge for community channel keys (ECIES wrap/unwrap
//  + AES-GCM symmetric encrypt/decrypt). Mirrors
//  apps/mobile/android/.../channelkey/ChannelKeyModule.kt
//
//  Implementation uses CryptoKit:
//    - X25519 ECDH via Curve25519.KeyAgreement
//    - HKDF-SHA256 via HKDF<SHA256>
//    - AES-256-GCM via AES.GCM
//
//  # Wire format (byte-compatible with Android)
//
//  Wrap output (returned by `wrapForRecipient`, consumed by `unwrapForSelf`):
//    [33 bytes: ephemeral X25519 pubkey, length-prefixed by libsignal]
//    [12 bytes: AES-GCM IV]
//    [N bytes: ciphertext]
//    [16 bytes: GCM tag]
//
//  Note: Android uses libsignal's 33-byte serialized public key (1-byte
//  type prefix + 32-byte raw). CryptoKit's `Curve25519.KeyAgreement.PublicKey`
//  serializes to a raw 32-byte representation — we add the leading 0x05
//  type byte manually so the wire format matches exactly.
//
//  Encrypt output (returned by `encryptMessage`, consumed by `decryptMessage`):
//    [12 bytes: AES-GCM IV]
//    [N bytes: ciphertext]
//    [16 bytes: GCM tag]
//
//  HKDF info string: "speakeasy-channel-key-wrap-v1"
//
//  # JS interface
//
//  See packages/crypto/src/channel-key.ts. Methods take base64 strings,
//  resolve with base64 strings.
//

import Foundation
import CryptoKit

@objc(ChannelKeyModule)
class ChannelKeyModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    private static let HKDF_INFO = Data("speakeasy-channel-key-wrap-v1".utf8)
    /// libsignal Curve25519 public-key type byte. Prepended so Android +
    /// iOS share an identical 33-byte wire shape.
    private static let CURVE25519_TYPE_BYTE: UInt8 = 0x05

    // MARK: - generateChannelKey

    /// Returns a fresh 32-byte AES key, base64-encoded.
    @objc(generateChannelKey:rejecter:)
    func generateChannelKey(_ resolve: RCTPromiseResolveBlock,
                            rejecter reject: RCTPromiseRejectBlock) {
        let key = SymmetricKey(size: .bits256)
        let bytes = key.withUnsafeBytes { Data(Array($0)) }
        resolve(bytes.base64EncodedString())
    }

    // MARK: - wrapForRecipient

    /// Wrap channelKey for `recipientIdentityPubB64` (their X25519 public key
    /// as a 33-byte libsignal-serialized blob, base64). Output: ephemeral pubkey
    /// + IV + ciphertext + tag (see file header), base64.
    @objc(wrapForRecipient:recipientIdentityPub:resolver:rejecter:)
    func wrapForRecipient(_ channelKeyB64: NSString,
                          recipientIdentityPub recipientPubB64: NSString,
                          resolver resolve: RCTPromiseResolveBlock,
                          rejecter reject: RCTPromiseRejectBlock) {
        do {
            let channelKey = try b64Decode(channelKeyB64 as String)
            let recipientPub = try parseLibsignalPubkey(recipientPubB64 as String)

            let ephemeralPriv = Curve25519.KeyAgreement.PrivateKey()
            let ephemeralPubData = ephemeralPriv.publicKey.rawRepresentation

            let shared = try ephemeralPriv.sharedSecretFromKeyAgreement(with: recipientPub)
            let aesKey = shared.hkdfDerivedSymmetricKey(
                using: SHA256.self,
                salt: Data(),
                sharedInfo: ChannelKeyModule.HKDF_INFO,
                outputByteCount: 32
            )

            let sealed = try AES.GCM.seal(channelKey, using: aesKey)
            // sealed.combined = nonce(12) || ciphertext || tag(16)
            guard let combined = sealed.combined else {
                reject("encrypt_failed", "AES.GCM seal returned nil combined buffer", nil)
                return
            }

            // Prefix with 33-byte serialized ephemeral pubkey so the
            // unwrap side can extract it without external length info.
            var out = Data()
            out.append(ChannelKeyModule.CURVE25519_TYPE_BYTE)
            out.append(ephemeralPubData)
            out.append(combined)
            resolve(out.base64EncodedString())
        } catch {
            reject("encrypt_failed", error.localizedDescription, error)
        }
    }

    // MARK: - unwrapForSelf

    /// Unwrap a wrapped key blob using the local identity private key.
    /// `selfIdentityPrivB64` is the X25519 private-key bytes (32 raw, base64)
    /// — the JS layer fetches it from SpeakeasySignalStore.
    @objc(unwrapForSelf:selfIdentityPriv:resolver:rejecter:)
    func unwrapForSelf(_ wrappedB64: NSString,
                       selfIdentityPriv selfPrivB64: NSString,
                       resolver resolve: RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
        do {
            let wrapped = try b64Decode(wrappedB64 as String)
            let selfPrivBytes = try b64Decode(selfPrivB64 as String)
            guard wrapped.count > 33 else {
                reject("decrypt_failed", "wrapped blob too short", nil)
                return
            }
            // Skip the 0x05 type byte; take the next 32 bytes as the
            // raw ephemeral pubkey.
            let ephemeralPubData = wrapped.subdata(in: 1..<33)
            let aesBlob = wrapped.subdata(in: 33..<wrapped.count)

            let ephemeralPub = try Curve25519.KeyAgreement.PublicKey(
                rawRepresentation: ephemeralPubData
            )
            let selfPriv = try Curve25519.KeyAgreement.PrivateKey(
                rawRepresentation: selfPrivBytes
            )
            let shared = try selfPriv.sharedSecretFromKeyAgreement(with: ephemeralPub)
            let aesKey = shared.hkdfDerivedSymmetricKey(
                using: SHA256.self,
                salt: Data(),
                sharedInfo: ChannelKeyModule.HKDF_INFO,
                outputByteCount: 32
            )

            let sealedBox = try AES.GCM.SealedBox(combined: aesBlob)
            let plaintext = try AES.GCM.open(sealedBox, using: aesKey)
            resolve(plaintext.base64EncodedString())
        } catch {
            reject("decrypt_failed", error.localizedDescription, error)
        }
    }

    // MARK: - encryptMessage / decryptMessage

    /// Encrypt a message under a channel key. Output: IV + ciphertext + tag, base64.
    @objc(encryptMessage:plaintext:resolver:rejecter:)
    func encryptMessage(_ channelKeyB64: NSString,
                        plaintext plaintextB64: NSString,
                        resolver resolve: RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
        do {
            let key = SymmetricKey(data: try b64Decode(channelKeyB64 as String))
            let plaintext = try b64Decode(plaintextB64 as String)
            let sealed = try AES.GCM.seal(plaintext, using: key)
            guard let combined = sealed.combined else {
                reject("encrypt_failed", "AES.GCM seal returned nil combined buffer", nil)
                return
            }
            resolve(combined.base64EncodedString())
        } catch {
            reject("encrypt_failed", error.localizedDescription, error)
        }
    }

    @objc(decryptMessage:ciphertext:resolver:rejecter:)
    func decryptMessage(_ channelKeyB64: NSString,
                        ciphertext ciphertextB64: NSString,
                        resolver resolve: RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
        do {
            let key = SymmetricKey(data: try b64Decode(channelKeyB64 as String))
            let combined = try b64Decode(ciphertextB64 as String)
            let sealedBox = try AES.GCM.SealedBox(combined: combined)
            let plaintext = try AES.GCM.open(sealedBox, using: key)
            resolve(plaintext.base64EncodedString())
        } catch {
            reject("decrypt_failed", error.localizedDescription, error)
        }
    }

    // MARK: - Helpers

    private func b64Decode(_ s: String) throws -> Data {
        guard let d = Data(base64Encoded: s) else {
            throw NSError(domain: "ChannelKey", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "invalid base64"])
        }
        return d
    }

    /// Parse a 33-byte libsignal-serialized X25519 public key (type byte +
    /// raw bytes) → CryptoKit `Curve25519.KeyAgreement.PublicKey`.
    private func parseLibsignalPubkey(_ b64: String) throws -> Curve25519.KeyAgreement.PublicKey {
        let data = try b64Decode(b64)
        guard data.count == 33 else {
            throw NSError(domain: "ChannelKey", code: -2,
                          userInfo: [NSLocalizedDescriptionKey:
                                        "expected 33-byte libsignal-serialized pubkey, got \(data.count)"])
        }
        guard data[0] == ChannelKeyModule.CURVE25519_TYPE_BYTE else {
            throw NSError(domain: "ChannelKey", code: -3,
                          userInfo: [NSLocalizedDescriptionKey:
                                        "unexpected pubkey type byte 0x\(String(data[0], radix: 16))"])
        }
        return try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: data.subdata(in: 1..<33)
        )
    }
}
