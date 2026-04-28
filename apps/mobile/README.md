# @speakeasy/mobile

React Native client for Speakeasy.

**Phase 1 status:** JS/TS layer complete and tested. Native iOS / Android
projects are **not** scaffolded — see "Add native shells" below.

## What works today

- Theme tokens (`src/theme/`) matching spec §14: dark / cream / gold / slate / pale,
  Inter (300/400/500), Syne (500/700), spacing + radius scales
- Brand components: `Wordmark` (with the gold silence-mark line), `IconMark`
  (two offset rounded rects + gold line, optional dark shell), `Button`
- API client (`src/api/client.ts`): typed `POST /v1/enroll`
- WebSocket client (`src/ws/client.ts`): connection lifecycle — connect →
  auth handshake → ping loop → exponential reconnect
- Vouchflow bridge (`src/native/vouchflow.ts`): `VouchflowClient` interface
  with `DevVouchflowClient` (HMAC stub against the server's dev secret) and
  `NativeVouchflowClient` (placeholder for the production native module)
- Zustand stores: `useIdentity`, `useConnection`
- Screens: `OnboardingScreen` (cream, IconMark, Continue → attest + enroll),
  `IdRevealScreen` (dark, "INTRODUCING", three Syne 38px words with gold
  separators, animated per spec §14 motion), `ConversationsScreen` (stub)
- Navigation (`src/navigation/RootNavigator.tsx`): React Navigation v7
  native stack, gated by `useIdentity`
- `App.tsx` opens the WebSocket with a `getToken` that re-attests on every
  reconnect; cleans up when identity clears

19 unit tests cover api / ws / vouchflow / stores. RN component rendering
is **not** under test (no RN test runtime configured here — that arrives
when native shells are added and Jest can use the RN preset).

## Add native shells (one-time)

```sh
cd apps/mobile
npx @react-native-community/cli@latest init Speakeasy --version 0.76.5 \
  --directory ./_tmp_init --skip-install --pm npm
mv _tmp_init/ios ./ios
mv _tmp_init/android ./android
rm -rf _tmp_init
```

Then in the generated `ios/Podfile` and `android/app/build.gradle`,
update the bundle id to `xyz.speakeasyapp.app` and verify the JS entry
point points at the existing `index.js` and `app.json`.

Add the brand fonts (Inter, Syne) to:

- `ios/<App>/Info.plist` under `UIAppFonts`, with the `.ttf` files placed
  in an Xcode asset reference
- `android/app/src/main/assets/fonts/` (filenames must match
  `src/theme/typography.ts`)

## Run

```sh
cd apps/mobile
npm run ios       # macOS only
npm run android   # requires Android SDK + emulator
npm run start     # Metro bundler
```

Server must be running at `http://localhost:8080` with
`VOUCHFLOW_DEV_SECRET=dev-shared-secret-replace-me` to match
`src/config.ts`.

## What lands later

| Phase | Adds |
| ----- | ---- |
| 2     | Real Signal Protocol native module (CryptoKit / Conscrypt), real PreKey bundles, SQLCipher + key derivation from Vouchflow device key |
| 2     | Real Vouchflow native module wired to `NativeVouchflowClient` |
| 3     | Chat screen, communities, disappearing-message TTL engine, media upload |
| 4     | Push notifications (notify-only), multi-device |
