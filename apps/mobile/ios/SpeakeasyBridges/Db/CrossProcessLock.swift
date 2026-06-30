//
//  CrossProcessLock.swift
//  Speakeasy
//
//  Advisory cross-process lock via flock() on a lock file in the App-Group
//  container. Serializes DecryptCache's lookup→decrypt→store between the app
//  and the Notification Service Extension so the Signal Double Ratchet advances
//  AT MOST ONCE for a ciphertext even when both processes see the same message
//  at the same instant (the in-process NSLock can't cross the process boundary).
//
//  No-op when `url` is nil (no App-Group container on this build) — the
//  in-process NSLock then provides the only serialization, exactly as before.
//
//  Foundation-only (Darwin POSIX) so it's unit-testable offline.
//

import Foundation

final class CrossProcessLock {
    private var fd: Int32 = -1

    init(url: URL?) {
        guard let url = url else { return }
        // O_CREAT so the lock file is made on first use; its contents are
        // irrelevant — only the flock matters.
        fd = open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        if fd < 0 {
            NSLog("[CrossProcessLock] open failed for \(url.path) (errno \(errno)) — falling back to in-process lock only")
        }
    }

    /// Block until the exclusive lock is held. No-op if the file couldn't open.
    func lock() {
        guard fd >= 0 else { return }
        while flock(fd, LOCK_EX) != 0 && errno == EINTR { /* retry on signal */ }
    }

    func unlock() {
        guard fd >= 0 else { return }
        _ = flock(fd, LOCK_UN)
    }

    deinit {
        if fd >= 0 { close(fd) }
    }
}
