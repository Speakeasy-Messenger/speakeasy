# Speakeasy

Private, end-to-end-encrypted messenger. No phone number, no email — just a
handle you pick (or let us suggest). Messages disappear by default. Built on Signal Protocol
1:1 + Sender Keys for groups, X25519 ECIES for community channel keys, and
Vouchflow for device-attested signup (no SIM, no captcha).

See [`spec.md`](./spec.md) for the full design.

## Layout

This is a Turborepo monorepo with npm workspaces.

```
apps/
  api/        Fastify + Drizzle + ioredis. WS, prekey bundles, message relay.
  mobile/     React Native 0.76, Hermes, new arch.
    android/   Kotlin native bridges (Vouchflow, Signal, ChannelKey, GroupMessaging)
    ios/       Swift native bridges (same four)
packages/
  shared/    Wire types, ID generators, conversation-id helpers
  crypto/    Signal Protocol + Channel Key + Group Messaging interfaces
  vouchflow/ Server-side Vouchflow validator + REST client
infra/
  fly/         Fly.io production config
  migrations/  Postgres SQL migrations
spec.md      Authoritative product + protocol spec
```

## Status

Active development. Current release line: **alpha-0.7.0** (latest tag
`alpha-0.7.0-rc.83`). The Android APK walks through real device attestation +
identity generation + 1:1 encrypt/decrypt end-to-end on hardware; the iOS
`.app` is packaged end-to-end on Xcode 26.4.1 (all four native bridges, Metro
bundle, SQLCipher + libsignal_ffi + Vouchflow linked). See the
[GitHub Releases](../../releases) page for the alpha APK.

Per-component status is tracked at the top of [`spec.md`](./spec.md) — Phases
0–4 complete (server + JS), Phase 5 (native bridges, SQLCipher persistence,
conversations/chat/calls UI) largely landed on Android with iOS counterparts
authored and CI-gated, and Phase 6 (1:1 voice calls, DTLS-SRTP over the Signal
session) in progress.

## Testing the alpha

1. Download `app-debug.apk` from the latest release and `adb install` it on
   a real Android device (Android 9+).
2. Open the app, tap **Continue** — biometric prompt + Play Integrity →
   identity generated → land on Conversations.
3. Tap **+ New chat**, paste a peer's handle, send a message.

The alpha points at a dev sandbox API server on a public IP. Production
DNS / TLS coming with Phase 5d.

## Real-device call verification

The call test harness boots directly into the production video-call screen,
feeds the physical camera through a real on-device WebRTC sender/receiver pair,
and verifies that native RTP frame counters advance while the app is
backgrounded. It does not place a server-routed two-user call.

- iOS: run **BrowserStack iOS call harness** and use
  `apps/mobile/maestro/20-call-pip-ios.yaml` with the generated IPA.
- Android: run **BrowserStack Android call harness** and use
  `apps/mobile/maestro/21-call-pip-android.yaml` plus
  `22-call-pip-close-android.yaml` with the generated APK.
- The workflows publish the signed app and Maestro suite together as a
  three-day GitHub Actions artifact. BrowserStack credentials stay outside
  the repository.

The automated stories cover entering background Picture in Picture (PiP),
continued video encoding/decoding, returning to the same call, and Android's
PiP close control. Screenshots provide the visual evidence for bubble content
and sizing. A real two-user call is still required to verify remote behavior,
iOS PiP close-to-end, and physical iPhone ringtone/vibration.

For a failed real call, open **About**, tap the version five times, choose
**Copy logs**, and paste the result into the bug report. The 200-event buffer
persists across app backgrounding and one relaunch. Call diagnostics record app
state, CallKit/PushKit lifecycle, PiP lifecycle and dimensions, WebRTC
connection state, and five-second inbound/outbound byte and frame counters.
The frame-counter entries do not record video frames, SDP, IP addresses, or
peer identifiers; the copied buffer still contains other support breadcrumbs
and should be treated as diagnostic data. On iOS, a log can prove that the VoIP
push arrived, CallKit completed the incoming-call report, and the audio session
activated; iOS does not expose a reliable callback proving that the speaker or
vibration motor physically fired, so ringtone/vibration remains an observed
device assertion.

## Building from source

```sh
npm install
npx turbo run build
```

Server tests:
```sh
npm test  # 91+ vitest tests across apps/api, packages/*, apps/mobile
```

Android APK:
```sh
cd apps/mobile/android
./gradlew :app:assembleDebug -Pvouchflow.apiKey=$VOUCHFLOW_WRITE_KEY
```

iOS (Mac required):
```sh
cd apps/mobile/ios
pod install
xcodebuild -workspace Speakeasy.xcworkspace -scheme Speakeasy build
```

See [`apps/mobile/ios/SpeakeasyBridges/README.md`](./apps/mobile/ios/SpeakeasyBridges/README.md)
for the one-time iOS toolchain setup.

## License

To be decided.
