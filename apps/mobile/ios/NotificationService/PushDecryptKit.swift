//
//  PushDecryptKit.swift
//  Speakeasy — shared rich-push decrypt + content build.
//
//  Used by the Notification Service Extension to turn the forwarded E2E
//  ciphertext into the real message preview, matching Android. Routes the
//  decrypt through the SAME `DecryptCache` the app uses (shared `decrypt_cache`
//  table in the App-Group DB), so the Double Ratchet advances AT MOST ONCE for
//  a given ciphertext no matter which process (app or NSE) sees it first.
//
//  Pure (no React) so it compiles into the extension target. Mirrors the
//  decrypt in SignalProtocolModule.decrypt (the RN bridge can't link here).
//
//  NOTE: this only succeeds once the SQLCipher DB lives in the App-Group
//  container (the migration) — until then `initializeFromDb()` can't open the
//  store from the extension and we fall back to the server banner.
//

import Foundation
import UserNotifications
import LibSignalClient

enum PushDecryptKit {
    /// The rich-push fields the server forwards — see push.fcm-apns.ts
    /// `buildIosPushData`. nil when the push has no ciphertext (basic banner).
    struct PushFields {
        let ciphertextB64: String
        let senderId: String
        let conversationId: String?
        let messageId: String?
    }

    static func fields(from userInfo: [AnyHashable: Any]) -> PushFields? {
        guard let ct = userInfo["ciphertext"] as? String, !ct.isEmpty,
              let sender = userInfo["sender_id"] as? String, !sender.isEmpty
        else { return nil }
        return PushFields(
            ciphertextB64: ct,
            senderId: sender,
            conversationId: userInfo["conversation_id"] as? String,
            messageId: userInfo["message_id"] as? String
        )
    }

    /// Decrypt + rewrite `content` (body preview, conversation thread, message
    /// category). Returns true on a real preview; false → keep the server
    /// fallback banner. Fails safe: any error keeps the original content.
    @discardableResult
    static func decryptAndBuild(
        _ f: PushFields,
        into content: UNMutableNotificationContent
    ) -> Bool {
        do {
            // Fresh NSE process → load the store from the shared DB; reused
            // process → it's already loaded. (No `isInitialized` accessor.)
            let store: SqlCipherSignalProtocolStore
            if let existing = try? SpeakeasySignalStore.require() {
                store = existing
            } else {
                guard SpeakeasySignalStore.initializeFromDb() else {
                    NSLog("[PushDecryptKit] store unavailable to extension (pre-App-Group-migration?)")
                    return false
                }
                store = try SpeakeasySignalStore.require()
            }
            let peer = try ProtocolAddress(name: f.senderId, deviceId: UInt32(1))

            guard let raw = Data(base64Encoded: f.ciphertextB64) else { return false }
            let bytes = [UInt8](raw)
            guard bytes.count > 1 else { return false }
            let typeByte = bytes[0]
            let body = Array(bytes.suffix(from: 1))
            guard typeByte == 0x03 || typeByte == 0x02 else { return false }
            let ctx = NullContext()

            // Same idempotent path the app uses — re-presentation (app already
            // decrypted over WS) returns the cached plaintext, no second ratchet.
            let plaintext = try DecryptCache.decryptCached(ciphertext: bytes) {
                if typeByte == 0x03 {
                    let msg = try PreKeySignalMessage(bytes: body)
                    return try signalDecryptPreKey(
                        message: msg, from: peer,
                        sessionStore: store, identityStore: store,
                        preKeyStore: store, signedPreKeyStore: store,
                        kyberPreKeyStore: store, context: ctx)
                } else {
                    let msg = try SignalMessage(bytes: body)
                    return try signalDecrypt(
                        message: msg, from: peer,
                        sessionStore: store, identityStore: store, context: ctx)
                }
            }

            content.body = preview(from: plaintext)
            if let cid = f.conversationId { content.threadIdentifier = cid }
            content.categoryIdentifier = "message"
            return true
        } catch {
            NSLog("[PushDecryptKit] decrypt failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Decrypted plaintext is `JSON.stringify(MessagePayload)` (attachments/index.ts);
    /// preview its `text`, else note an attachment, else a generic.
    private static func preview(from plaintext: [UInt8]) -> String {
        guard let s = String(bytes: plaintext, encoding: .utf8) else { return "New message" }
        if let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let t = (obj["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !t.isEmpty {
                return t
            }
            if let atts = obj["attachments"] as? [Any], !atts.isEmpty { return "📎 Attachment" }
            return "New message"
        }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "New message" : t
    }
}
