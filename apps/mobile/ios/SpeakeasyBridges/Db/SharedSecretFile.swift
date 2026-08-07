//
//  SharedSecretFile.swift
//  Speakeasy
//
//  Mirrors the SpeakeasyDb root secret into the App-Group container so the
//  Notification Service Extension (a separate process with no access to the
//  app's default keychain group) can derive the SQLCipher passphrase and open
//  the shared store to decrypt rich pushes.
//
//  Security: the canonical secret stays in the Keychain (DbKeyStore, untouched).
//  This is an ADDITIVE copy in a file protected with
//  `.completeFileProtectionUntilFirstUserAuthentication` — encrypted at rest,
//  readable only after the first unlock following a reboot (same accessibility
//  as the keychain item: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
//  The exposure surface is the App-Group members (app + NSE), same as a shared
//  keychain group would be. Worst case if it's missing/unreadable: the NSE
//  can't decrypt and falls back to the server banner — never any data loss.
//
//  App writes; the extension only reads (never seeds).
//

import Foundation

enum SharedSecretFile {
    private static let filename = "db-root-secret"

    private static func fileURL() -> URL? {
        AppGroup.containerURL()?.appendingPathComponent(filename, isDirectory: false)
    }

    /// Mirror `secret` into the App-Group container. Idempotent (skips the write
    /// when the file already holds the same value). Non-fatal on failure — the
    /// app keeps working; only the NSE's rich preview is affected. App-only.
    static func writeIfNeeded(_ secret: String) {
        guard let url = fileURL() else { return }
        if let existing = read(), existing == secret { return }
        do {
            try Data(secret.utf8).write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            NSLog("[SharedSecretFile] mirrored db root secret into App-Group for the NSE")
        } catch {
            NSLog("[SharedSecretFile] mirror write failed (non-fatal): \(error)")
        }
    }

    static func read() -> String? {
        guard let url = fileURL(), let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Remove the mirror (account deletion / store reset).
    static func clear() {
        guard let url = fileURL() else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
