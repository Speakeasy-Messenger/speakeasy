# iOS ⇄ Android parity

Speakeasy is one React Native 0.76.5 codebase. Almost all of
`apps/mobile/src/` is shared TypeScript and reaches both platforms for
free. This document is the **ledger of where the two platforms actually
diverge** — so an Android-side fix can't silently fail to reach iOS.

Keep it current: every new `Platform.OS` branch or `// 🍎` deferral
should land a row here in the same PR.

_Last audited: 2026-05-18, after the iOS hardening initiative (Steps
0–2). iOS now builds clean and is CI-gated — see `HARDENING.md`._

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

| Module          | Android (Kotlin)            | iOS (Swift)                    | Status |
| --------------- | --------------------------- | ------------------------------ | ------ |
| SignalProtocol  | `SignalProtocolModule.kt`   | `SignalProtocolModule.swift`   | ✅ parity |
| GroupMessaging  | `GroupMessagingModule.kt`   | `GroupMessagingModule.swift`   | ✅ parity |
| ChannelKey      | `ChannelKeyModule.kt`       | `ChannelKeyModule.swift`       | ✅ parity |
| Vouchflow       | `VouchflowModule.kt`        | `VouchflowModule.swift`        | ✅ parity |
| SpeakeasyDb     | `SpeakeasyDb.kt` / `Schema` | `SpeakeasyDb.swift` / `Schema` | ✅ parity |
| Version         | `VersionModule.kt`          | `Version/VersionModule.swift`  | ✅ parity |

SDK versions — aligned: LibSignal `0.59.0` (both), SQLCipher `~4.6`
iOS / `4.14.1` Android, Vouchflow `2.1.1` (both).

## 3. `Platform.OS` divergence ledger

Intentional differences (correct, no action):

- `ChatScreen.tsx`, `NewGroupScreen.tsx`, `GroupSettingsScreen.tsx`,
  `GroupChatScreen.tsx`, `onboarding/HandleStep.tsx` —
  `KeyboardAvoidingView behavior` is `'padding'` on iOS only.
- `push-notifications.ts:160` — platform tag on the push token.
- `attachments/save-and-open.ts` — Android external dir + `scanFile()`
  MediaStore injection vs iOS `DocumentDirectoryPath`.
- `attachments/save-to-gallery.ts` — Android API-level gate.
- `RichMessageText.tsx` — Android-only word-break handling.

Open gap:

- **`push-handler.ts` (`Platform.OS === 'android'` block)** — the
  entire background-message handler, notifee event handlers, and
  inline reply are Android-only. iOS has **zero** app-side push
  handling. → Track 4, designed in `PUSH-PARITY.md`.

Resolved during the hardening initiative:

- ✅ Version module — iOS now has `SpeakeasyBridges/Version`;
  `version.ts` reads the native module on both platforms (was
  hardcoded `0.0.0-test` on iOS).
- ✅ Copy confirmation — the Android-only `ToastAndroid` was replaced
  by the cross-platform `<Toast>`.

Audited, accepted as-is (low priority):

- `permissions/startup.ts`, `permissions/runtime.ts` — iOS no-ops the
  runtime-permission flow (relies on system dialogs); no "denied →
  Settings deep-link" path.
- `callkeep-bridge.ts` — Android-only CallKeep registration; the iOS
  CallKit path still needs an end-to-end verification pass.

## 4. iOS gaps, ranked

1. **Push notifications** — background handling, payload decrypt,
   rich display, and inline reply are all absent on iOS. The one
   large remaining gap; design in `PUSH-PARITY.md`.
2. Runtime permissions — no Settings deep-link on denial. Acceptable.
3. CallKit path — declared but unverified end-to-end on iOS.

Resolved: first iOS build (Step 0), CI gate (`ios.yml`), Version
module, crash handler (`AppDelegate.mm`), Vouchflow SDK alignment.

## 5. `// 🍎`-deferred markers in the contracts

Comments in `packages/crypto/src/` (`signal-protocol.ts:3`,
`channel-key.ts:8`, `group-messaging.ts:3`) marked iOS as deferred.
The native modules now exist and compile — these comments are stale
and should be cleared once each module is verified against the
contract on a real device.

## 6. Hardening initiative status

See `HARDENING.md` for the live tracker.

- ✅ Step 0 — first clean iOS build
- ✅ Track 1 — `ios.yml` CI build gate
- ✅ Track 2 — Vouchflow 2.1.1, crash handler, Version module, copy toast
- 📋 Track 4 — iOS push parity — designed (`PUSH-PARITY.md`), not built
- ✅ This audit doc
