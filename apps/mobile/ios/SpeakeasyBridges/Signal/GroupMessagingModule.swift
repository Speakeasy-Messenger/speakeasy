//
//  GroupMessagingModule.swift
//  Speakeasy
//
//  Phase 5b iOS — RN bridge for Signal Sender Keys (group messaging).
//  Mirrors apps/mobile/android/.../signal/GroupMessagingModule.kt
//
//  See the Kotlin module's header for the mental model — same wire
//  format, same JS interface, same error reasons.
//
//  # libsignal-client iOS API NOTE
//
//  Sender Keys APIs on iOS use free functions
//  (`groupEncrypt`, `groupDecrypt`) plus
//  `SenderKeyDistributionMessage(from:distributionId:store:context:)` to
//  create one. Anything marked `// libsignal:` is best-guess — verify
//  on first compile.
//

import Foundation
import LibSignalClient

@objc(GroupMessagingModule)
class GroupMessagingModule: NSObject {

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    private let deviceId: UInt32 = 1
    private let context = NullContext()

    @objc(createSenderKeyDistribution:resolver:rejecter:)
    func createSenderKeyDistribution(_ distributionIdStr: NSString,
                                     resolver resolve: @escaping RCTPromiseResolveBlock,
                                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let store = try SpeakeasySignalStore.require()
            guard let distributionId = UUID(uuidString: distributionIdStr as String) else {
                reject("bad_distribution_id", "not a valid UUID", nil)
                return
            }
            let selfName = try selfAddressName(store)
            let selfAddr = try ProtocolAddress(name: selfName, deviceId: deviceId)
            // libsignal: factory creates a fresh SenderKey for self, persists it.
            let skdm = try SenderKeyDistributionMessage(
                from: selfAddr,
                distributionId: distributionId,
                store: store,
                context: context
            )
            resolve(Data(skdm.serialize()).base64EncodedString())
        } catch {
            reject("unknown_error", error.localizedDescription, error)
        }
    }

    @objc(processSenderKeyDistribution:skdmBytes:resolver:rejecter:)
    func processSenderKeyDistribution(_ senderUserId: NSString,
                                      skdmBytes skdmB64: NSString,
                                      resolver resolve: @escaping RCTPromiseResolveBlock,
                                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let store = try SpeakeasySignalStore.require()
            let bytes = Array(b64(skdmB64 as String))
            let skdm = try SenderKeyDistributionMessage(bytes: bytes)
            let senderAddr = try ProtocolAddress(name: senderUserId as String, deviceId: deviceId)
            // libsignal: process inbound SKDM into the store.
            try processSenderKeyDistributionMessage(
                skdm,
                from: senderAddr,
                store: store,
                context: context
            )
            resolve(NSNull())
        } catch {
            reject("unknown_error", error.localizedDescription, error)
        }
    }

    @objc(encryptForGroup:plaintext:resolver:rejecter:)
    func encryptForGroup(_ distributionIdStr: NSString,
                         plaintext plaintextB64: NSString,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let store = try SpeakeasySignalStore.require()
            guard let distributionId = UUID(uuidString: distributionIdStr as String) else {
                reject("bad_distribution_id", "not a valid UUID", nil)
                return
            }
            let selfName = try selfAddressName(store)
            let selfAddr = try ProtocolAddress(name: selfName, deviceId: deviceId)
            let plaintext = Array(b64(plaintextB64 as String))
            // libsignal: returns CiphertextMessage (SenderKeyMessage shape).
            let msg = try groupEncrypt(
                plaintext,
                from: selfAddr,
                distributionId: distributionId,
                store: store,
                context: context
            )
            resolve(Data(msg.serialize()).base64EncodedString())
        } catch SignalError.sessionNotFound(_) {
            reject("no_session", "no SenderKey for this distributionId", nil)
        } catch {
            reject("unknown_error", error.localizedDescription, error)
        }
    }

    @objc(decryptFromGroupMember:ciphertext:resolver:rejecter:)
    func decryptFromGroupMember(_ senderUserId: NSString,
                                ciphertext ciphertextB64: NSString,
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        do {
            let store = try SpeakeasySignalStore.require()
            let senderAddr = try ProtocolAddress(name: senderUserId as String, deviceId: deviceId)
            let bytes = Array(b64(ciphertextB64 as String))
            let plaintext = try groupDecrypt(
                bytes,
                from: senderAddr,
                store: store,
                context: context
            )
            resolve(Data(plaintext).base64EncodedString())
        } catch SignalError.sessionNotFound(_) {
            reject("no_session", "no SenderKey from this sender", nil)
        } catch SignalError.duplicatedMessage(_) {
            reject("duplicate_message", "already consumed this counter", nil)
        } catch SignalError.invalidMessage(_) {
            reject("invalid_message", "corrupted ciphertext", nil)
        } catch {
            reject("unknown_error", error.localizedDescription, error)
        }
    }

    // MARK: - Helpers

    /// Self-address name = base64(local identity public key) — same
    /// convention as the Kotlin module.
    private func selfAddressName(_ store: SqlCipherSignalProtocolStore) throws -> String {
        let ikp = try store.identityKeyPair(context: context)
        return Data(ikp.publicKey.serialize()).base64EncodedString()
    }

    private func b64(_ s: String) -> Data {
        return Data(base64Encoded: s) ?? Data()
    }
}
