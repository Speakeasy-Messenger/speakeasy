# iOS ⇄ Android parity

Speakeasy is one React Native 0.76.5 codebase. Almost all of
`apps/mobile/src/` is shared TypeScript and reaches both platforms for
free. This document is the **ledger of where the two platforms actually
diverge** — so an Android-side fix can't silently fail to reach iOS.

Keep it current: every new `Platform.OS` branch or `// 🍎` deferral
should land a row here in the same PR.

_Last audited: 2026-05-18 (rc.106)._

> **Reality check — iOS has never been compile-verified.**
> `SpeakeasyBridges/README.md` states the native Swift (including the
> libsignal crypto bindings) was authored on a Linux box without
> `xcodebuild`, and the repo `CLAUDE.md` says the repo is not yet
> cloned on the Mac. So the first milestone is a *successful iOS
> build* — every parity item below is downstream of that and cannot
> be verified until iOS compiles and runs once.

## 1. Shared — no per-platform work

The crypto core has full parity: shared TypeScript contracts in
`packages/crypto/src/` (`signal-protocol.ts`, `group-messaging.ts`,
`channel-key.ts`), with byte-compatible wire formats and matching
native implementations on both sides.

- Signal Protocol (1:1) · Group Messaging (Sender Keys) · Channel Keys
  (community ECIES) · SQLCipher store · Vouchflow bridge.

All app logic in `src/` (stores, screens, WS, navigation, the
`src/integration/` test harness) is shared and platform-agnostic.

## 2. Native module parity

| Module          | Android (Kotlin)            | iOS (Swift)                  | Status |
| --------------- | --------------------------- | ---------------------------- | ------ |
| SignalProtocol  | `SignalProtocolModule.kt`   | `SignalProtocolModule.swift` | ✅ parity |
| GroupMessaging  | `GroupMessagingModule.kt`   | `GroupMessagingModule.swift` | ✅ parity |
| ChannelKey      | `ChannelKeyModule.kt`       | `ChannelKeyModule.swift`     | ✅ parity |
| Vouchflow       | `VouchflowModule.kt`        | `VouchflowModule.swift`      | ✅ parity |
| SpeakeasyDb     | `SpeakeasyDb.kt` / `Schema` | `SpeakeasyDb.swift` / `Schema` | ✅ parity |
| **Version**     | `VersionModule.kt`          | **missing**                  | ❌ GAP |

SDK versions — keep aligned: LibSignal `0.59.0` (both), SQLCipher
`~4.6` iOS / `4.14.1` Android, Vouchflow **`2.0.0` iOS / `2.1.1`
Android** (iOS behind — see gaps).

## 3. `Platform.OS` divergence ledger

Intentional differences (correct, no action):

- `ChatScreen.tsx`, `NewGroupScreen.tsx`, `GroupSettingsScreen.tsx`,
  `GroupChatScreen.tsx`, `onboarding/HandleStep.tsx` —
  `KeyboardAvoidingView behavior` is `'padding'` on iOS only. Correct.
- `push-notifications.ts:160` — platform tag on the push token.
- `attachments/save-and-open.ts` — Android external dir + `scanFile()`
  MediaStore injection vs iOS `DocumentDirectoryPath`. Correct.
- `attachments/save-to-gallery.ts:21` — Android API-level gate.
- `RichMessageText.tsx:48` — Android-only word-break handling.

Gaps (iOS missing or stubbed):

- **`push-handler.ts` (~`Platform.OS === 'android'` block)** — the
  entire background-message handler, notifee event handlers, and
  inline reply are Android-only. iOS has **zero** app-side push
  handling. → Track 4.
- **`version.ts:47`** — iOS returns hardcoded `'0.0.0-test'`; no native
  Version module. → Track 2.
- `permissions/startup.ts:23`, `permissions/runtime.ts:75` — iOS
  no-ops the runtime-permission flow (relies on system dialogs). No
  "denied → deep-link to Settings" path. → audited, low priority.
- `callkeep-bridge.ts:147` — Android-only CallKeep registration; iOS
  CallKit path needs a verification pass. → audited.
- `RichMessageText.tsx` copy confirmation — `ToastAndroid` is
  Android-only; iOS copies silently with no feedback (introduced
  rc.106). → Track 2.

## 4. iOS gaps, ranked

1. **Push notifications** — background handling, payload decrypt,
   MessagingStyle stacking, and inline reply are all absent on iOS.
   Largest gap; a real feature build, not a port.
2. **Version module** — missing → iOS always reports `0.0.0-test`,
   so a tester's build is unidentifiable. 35 LOC to fix.
3. **Crash reporting** — `AppDelegate.mm` has no uncaught-exception
   handler. Android writes crash files to Downloads for sideloaded
   testers; iOS captures nothing.
4. **Runtime permissions** — iOS relies entirely on system dialogs;
   no Settings deep-link on denial. Acceptable for now.
5. **CI/CD** — no `ios.yml`; iOS builds/tests are manual → drift is
   invisible until someone builds locally.

## 5. `// 🍎`-deferred markers in the contracts

These comments in `packages/crypto/src/` are deferral markers, not
bugs — listed so they aren't forgotten:

- `signal-protocol.ts:3` — "iOS: CryptoKit bridged to RN — 🍎 deferred".
- `channel-key.ts:8` — "wire format must stay in sync … iOS 🍎 queued".
- `group-messaging.ts:3` — "iOS … 🍎 deferred".

The native modules now exist (§2), so these comments are stale — update
them when each module is verified against the contract on-device.

## 6. Remediation tracks

1. **iOS CI gate** — `.github/workflows/ios.yml`: `pod install` +
   `xcodebuild build` (simulator SDK, no signing) + Simulator smoke
   test. The forcing function that makes drift visible.
2. **Quick parity fixes** — Version Swift module; crash handler in
   `AppDelegate`; cross-platform copy confirmation.
3. **iOS push parity** — APNs background handling + a Notification
   Service Extension for on-device decrypt + `UNNotificationAction`
   inline reply.
4. **Keep this doc current** — new `Platform.OS` branch ⇒ new row here.
