# iOS Notification Service Extension — design + ratchet hand-off

**Status: DESIGN, awaiting sign-off.** Nothing in here that touches live Signal
session state or the on-disk store is built yet. The non-live scaffolding
(target, shared decrypt-and-build module skeleton, dev harness) can land first;
the four ⚠️ LIVE-STATE steps are gated on approval of this doc.

## Goal

Match Android: show the **decrypted message text + sender avatar** in iOS
notifications. The server (`apps/api/src/push/push.fcm-apns.ts`) already sends iOS
an alert push with `mutable-content:1` + the **ciphertext in the data block**, so
it's already provisioned for an NSE to decrypt. There is no NSE today, so iOS
shows the generic server banner.

## Components

1. **`NotificationService` target** — new iOS app-extension (UNNotificationServiceExtension).
2. **`PushDecryptKit`** — the decrypt-and-build logic, factored into a small
   Swift module/source set shared by BOTH the NSE and the dev harness, so the
   exact same code path is exercised on the rig and in production.
3. **Shared store access** — the SQLCipher DB reachable from the extension.
4. **`DevPushHarness`** (already started, JS side) — invokes `PushDecryptKit`
   with a crafted ciphertext + a seeded test session and shows the result as a
   LOCAL notification, so the rig screenshots the real decrypt output on a real
   iPhone (only the APNs→NSE OS trigger is faked).

## Shared-store access — prerequisite migrations  ⚠️ LIVE-STATE

- **DB file**: `SpeakeasyDb.databasePath()` is the app's private container; the
  NSE is a separate process and can't read it. Move `speakeasy.db` (+ `-wal`,
  `-shm`) into the App Group container `group.xyz.speakeasyapp.app`. Migration on
  app launch: if the file exists only in the old location, copy→fsync→verify-open
  →swap, **back up not delete** the old one (mirrors the existing orphan-backup
  discipline in `resolveRootSecret`). Both targets point `databasePath()` at the
  group container.
- **DB root secret**: `DbKeyStore` (keychain). Add `kSecAttrAccessGroup =
  <teamID>.group.xyz.speakeasyapp.app` so the extension can read the same secret.
  Migrate the existing item's access group in place (re-add under the shared
  group, then delete the private-group copy).
- **Pods**: `LibSignalClient` + SQLCipher must build for the extension target
  (add to its `target` in the Podfile; `USE_FRAMEWORKS=static` already).

## The ratchet hand-off — the core correctness design  ⚠️ LIVE-STATE

**The landmine:** decrypting an incoming message advances the Signal *receiving*
ratchet (`signalDecrypt`/`signalDecryptPreKey` mutate + persist `sessionStore`).
If the NSE (on push) and the main app (on WS delivery) both decrypt the same
message, the second decrypt fails or the session state diverges → that
conversation stops decrypting. User-data-destroying.

**Design: single-decryptor, with a cross-process lock + a shared decrypted-inbox
for dedup.** Idempotency key = the server message-id (present in BOTH the push
data block and the WS frame).

1. Before touching any session, a decryptor (NSE *or* app) takes a **cross-process
   lock** — `NSFileCoordinator` / `flock` on a lock file in the App Group
   container, keyed per peer session.
2. It checks the **`decrypted_inbox`** table (new table in the shared DB): if this
   message-id is already there, **skip decrypt** and use the stored plaintext.
3. Otherwise it decrypts (advancing + persisting the ratchet) AND writes
   `{message_id, plaintext, ts}` to `decrypted_inbox` — **in ONE SQLCipher
   transaction** so the ratchet advance and the plaintext record commit
   atomically (no "ratchet moved but plaintext lost" window).
4. Releases the lock.
5. The app's WS-receive path is changed to consult `decrypted_inbox` first
   (dedup): if the NSE already decrypted, read the plaintext, do NOT re-decrypt.
6. `decrypted_inbox` is pruned by TTL / on conversation read.

**Failure modes (all fail safe to the generic banner, never a wrong/duplicate
ratchet advance):**
- NSE can't get the lock within the ~30 s budget → don't decrypt → generic
  banner; the app decrypts later over WS.
- Keychain locked (post-reboot, not yet unlocked) → can't read DB key → generic
  banner. (Same `keyUnavailable` discipline as today — never wipe.)
- NSE killed mid-decrypt → the single-transaction commit means it either fully
  applied (ratchet+inbox) or not at all.

## Verification boundary

- `PushDecryptKit` decrypt + content build: **rig** (DevPushHarness → real
  libsignal/SQLCipher decrypt → local notif → screenshot) + an **offline Mac**
  two-store simulation for the lock/dedup correctness.
- Real **APNs → NSE** trigger + live cross-process timing: **your device**, a
  TestFlight build (the BrowserStack rig resigns the app, breaking the APNs
  topic, so it can't receive the real push).

## Build order

1. (no sign-off needed) NSE target + `PushDecryptKit` skeleton + DevPushHarness +
   the JS category/reply wiring (Increment 1, already written).
2. ⚠️ DB→App-Group migration + shared keychain group.
3. ⚠️ `decrypted_inbox` table + cross-process lock + `PushDecryptKit` live decrypt.
4. ⚠️ App WS-receive dedup against `decrypted_inbox`.
5. Server: add `category`, `thread-id`, sender to the `aps` payload.
