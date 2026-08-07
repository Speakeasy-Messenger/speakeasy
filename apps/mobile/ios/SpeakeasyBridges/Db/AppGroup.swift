//
//  AppGroup.swift
//  Speakeasy
//
//  Shared App-Group container access, so the Notification Service Extension
//  (a separate process) can reach the same encrypted store + cross-process
//  lock file the main app uses. The group id matches the
//  `com.apple.security.application-groups` entitlement on BOTH targets:
//  see Speakeasy.entitlements and the NotificationService extension.
//
//  Pure infrastructure — touches no data. The DB-move migration and the
//  DecryptCache cross-process lock build on this; until those land it is
//  unused and harmless.
//

import Foundation

enum AppGroup {
    /// Must equal the App-Group entitlement on the app + the NSE target.
    static let identifier = "group.xyz.speakeasyapp.app"

    /// The shared container root, or nil if the entitlement isn't present
    /// (e.g. a build/target without the App Group — callers fall back to the
    /// process-private path so nothing breaks before the migration ships).
    static func containerURL() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    /// Shared location for the SQLCipher DB once migrated into the group
    /// container. nil when the container is unavailable.
    static func databaseURL(filename: String) -> URL? {
        containerURL()?.appendingPathComponent(filename, isDirectory: false)
    }

    /// Lock file backing the cross-process DecryptCache lock. Created lazily
    /// by the lock; its contents are irrelevant — only the flock matters.
    static func decryptLockURL() -> URL? {
        containerURL()?.appendingPathComponent("decrypt.lock", isDirectory: false)
    }
}
