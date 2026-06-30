//
//  DbMigration.swift
//  Speakeasy
//
//  Pure (Foundation-only) App-Group DB migration, factored out of SpeakeasyDb
//  so it can be unit-tested offline (no SQLCipher / device / entitlement).
//
//  COPY (never move) the closed SQLCipher DB + sidecars from the legacy private
//  container into the App-Group container, so the Notification Service Extension
//  can open the same store. Runs at first-open (no concurrent writer → the copy
//  is a consistent snapshot). Rolls back a partial copy and falls through to the
//  legacy path on any failure — a botched migration degrades to "extension
//  can't decrypt yet", never lost data (the legacy file is always preserved).
//

import Foundation

enum DbMigration {
    /// Main DB + SQLCipher sidecars (WAL or rollback-journal mode).
    static let sidecars = ["", "-journal", "-wal", "-shm"]

    /// Decide the active DB path and perform the one-time migration.
    /// `group == nil` → no App-Group container on this build → use `legacy`.
    static func resolveActivePath(
        legacy: String,
        group: String?,
        fm: FileManager = .default
    ) -> String {
        guard let group = group else { return legacy }

        // Migrate only when the group DB isn't there yet AND there's a legacy
        // DB to bring over. (Fresh install: no legacy → store is created fresh
        // in the group container. Already migrated: group exists → no-op.)
        if !fm.fileExists(atPath: group), fm.fileExists(atPath: legacy) {
            if !copyAll(from: legacy, to: group, fm: fm) {
                for s in sidecars { try? fm.removeItem(atPath: group + s) } // roll back
                NSLog("[DbMigration] rolled back — using legacy path")
                return legacy
            }
            NSLog("[DbMigration] migrated DB into App-Group container (legacy kept as fallback)")
        }
        return group
    }

    /// Copy main + sidecars; returns false on the first failure so the caller
    /// rolls back (we must never leave a torn group DB).
    static func copyAll(from legacy: String, to group: String, fm: FileManager = .default) -> Bool {
        for suffix in sidecars {
            let src = legacy + suffix
            guard fm.fileExists(atPath: src) else { continue }
            let dst = group + suffix
            try? fm.removeItem(atPath: dst) // clear any half-prior attempt
            do {
                try fm.copyItem(atPath: src, toPath: dst)
            } catch {
                NSLog("[DbMigration] copy failed (\(suffix.isEmpty ? "db" : suffix)): \(error)")
                return false
            }
        }
        return true
    }
}
