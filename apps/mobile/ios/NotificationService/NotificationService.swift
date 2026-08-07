//
//  NotificationService.swift
//  Speakeasy — rich-push Notification Service Extension
//
//  Decrypts the E2E ciphertext the server forwards in the push `data` block
//  (mutable-content:1) and rewrites the notification body to the real message,
//  matching Android. The actual decrypt + content build lives in the shared
//  `PushDecryptKit` (added in the next step) so the exact same path is exercised
//  by the dev harness and in production.
//


import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content =
            (request.content.mutableCopy() as? UNMutableNotificationContent)
            ?? UNMutableNotificationContent()
        self.bestAttempt = content

        // Decrypt the forwarded ciphertext + rewrite the body to the real
        // message. Fails safe (keeps the server banner) if the push carries no
        // ciphertext or the store isn't reachable yet.
        if let fields = PushDecryptKit.fields(from: request.content.userInfo) {
            PushDecryptKit.decryptAndBuild(fields, into: content)
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS is about to kill us — hand back the best we have so the user at
        // least sees the original (server-provided) banner.
        if let handler = contentHandler, let content = bestAttempt {
            handler(content)
        }
    }
}
