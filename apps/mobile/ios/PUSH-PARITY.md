# iOS push parity — spec (Track 4)

Design for bringing iOS push notifications to parity with Android.
Written 2026-05-18; **not yet implemented** — this is the executable
plan. Companion to `HARDENING.md` (Track 4) and `PARITY.md`.

## Goal

Match Android push behaviour on iOS: decrypt push payloads on-device,
render a rich notification, and support inline reply from the banner.

## Current state

iOS has **zero app-side push handling** — the entire background
pipeline in `apps/mobile/src/push/push-handler.ts` is wrapped in
`if (Platform.OS === 'android')`. iOS shows whatever plain alert the
server sends; no decryption, no MessagingStyle, no inline reply.

Android, for contrast: server sends a data-only FCM message →
`setBackgroundMessageHandler` decrypts the ciphertext on-device →
notifee renders a MessagingStyle notification with a RemoteInput
reply action.

## Architecture — four parts

### 1. APNs delivery (server)

- `apps/api/src/push/push.fcm-apns.ts` exists; iOS device tokens are
  already registered (tagged `'ios'` in `push-notifications.ts:160`).
- **Change needed:** iOS *message* pushes must be sent as
  `mutable-content: 1` alerts carrying the ciphertext in the payload,
  so the Notification Service Extension can intercept and decrypt.
- Payload budget: APNs alerts cap at 4 KB — the ciphertext only fits
  for 'rich' messages (same constraint as Android's FCM data path;
  see `FcmData.ciphertext`).
- First task: confirm whether `push.fcm-apns.ts` already speaks APNs
  or only routes iOS through FCM.

### 2. Notification Service Extension (NSE)

- New Xcode target: a `UNNotificationServiceExtension`.
- Per push it gets ~30 s and limited memory to decrypt the ciphertext,
  rewrite `bestAttemptContent.body`, and attach the sender avatar.
- It needs the crypto stack: its own pod target for `LibSignalClient`
  + `SQLCipher`, and access to the Signal store (part 3).
- Decrypt must be idempotent — the same message also drains over the
  WebSocket in-app (mirrors Android's `DecryptCache`).

### 3. App Group + shared Signal store — the crux

- The NSE runs in a separate process; it cannot read the app's
  private container.
- Add an **App Group** entitlement (e.g. `group.xyz.speakeasyapp.app`)
  to both the app target and the NSE target.
- The SQLCipher Signal store + the Vouchflow device token must live in
  the App Group container so both processes can open them.
- **No migration needed** — iOS has no installed userbase yet, so the
  store is simply *born* in the App Group container. This free lunch
  exists only because we do it before iOS ships; on an Android-scale
  userbase it would be a risky data migration.
- Touch points: `SpeakeasyDb.swift`, `SpeakeasySignalStore.swift`,
  `SqlCipherSignalProtocolStore.swift` — resolve the DB path via
  `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`.

### 4. Rich display + inline reply

- `UNNotificationCategory` with a `UNTextInputNotificationAction`
  ("Reply") — the iOS counterpart of Android's RemoteInput.
- Reply handling: the app's `UNUserNotificationCenterDelegate` receives
  the text → encrypt + send over WS. Reuse `reply-sender.ts` — it is
  already platform-agnostic; only its registration in `push-handler.ts`
  is Android-gated.
- Rich look: donate an `INSendMessageIntent` for the avatar + sender
  styling (the closest equivalent to Android's MessagingStyle).
- Unwind the `Platform.OS === 'android'` gates in `push-handler.ts`.

## Task breakdown (ordered)

1. App Group entitlement on the app target; relocate the SQLCipher
   store to the App Group container; confirm the app still builds and
   the store opens.
2. Server: send iOS message pushes as `mutable-content` + ciphertext.
3. New NSE target + its pod target; a minimal NSE that decrypts and
   rewrites the notification body.
4. Cross-process idempotent decrypt — NSE vs in-app WS path.
5. `UNNotificationCategory` + inline reply wired to `reply-sender.ts`.
6. `INSendMessageIntent` rich display.
7. Unwind the `push-handler.ts` `Platform.OS` gates; update `PARITY.md`.

## Risks / open questions

- **Signal ratchet corruption — top risk.** The NSE and the in-app WS
  path could decrypt the same session concurrently and advance the
  ratchet twice. The idempotent decrypt-cache discipline must extend
  across processes (shared, in the App Group container).
- **NSE memory limit (~24 MB)** — libsignal + SQLCipher inside the
  extension must stay within budget.
- **Verification gap** — APNs + the NSE cannot be fully exercised on
  the simulator; needs a real device on the push sandbox. This ties
  into the "no iOS testers" problem — a device test loop should be set
  up before/with this work.

## Verification plan

- `ios.yml` compile-gates the new NSE target.
- Functional: real device on the APNs sandbox — send a message,
  confirm the banner shows *decrypted* text, reply from the banner,
  confirm it sends. No simulator shortcut for the full path.
