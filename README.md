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
