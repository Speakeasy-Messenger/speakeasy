# Speakeasy iOS native bridges (Phase 5b)

Swift/ObjC counterparts of the five Android Kotlin bridges under
`apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/`.

| Module           | iOS file                                           | Android counterpart                  | JS-side name           |
| ---------------- | -------------------------------------------------- | ------------------------------------ | ---------------------- |
| Vouchflow        | `Vouchflow/VouchflowModule.{swift,m}`              | `vouchflow/VouchflowModule.kt`       | `NativeModules.Vouchflow`     |
| Channel keys     | `ChannelKey/ChannelKeyModule.{swift,m}`            | `channelkey/ChannelKeyModule.kt`     | `NativeModules.ChannelKey`    |
| Signal Protocol  | `Signal/SignalProtocolModule.{swift,m}`            | `signal/SignalProtocolModule.kt`     | `NativeModules.SignalProtocol`|
| Group Messaging  | `Signal/GroupMessagingModule.{swift,m}`            | `signal/GroupMessagingModule.kt`     | `NativeModules.GroupMessaging`|
| Version          | `Version/VersionModule.{swift,m}`                  | `version/VersionModule.kt`           | `NativeModules.SpeakeasyVersion`|

Plus the persistence + store layer (no direct JS interface — used by the
modules above):

| File                                     | Android counterpart                                |
| ---------------------------------------- | -------------------------------------------------- |
| `Db/SpeakeasyDb.swift`                   | `db/SpeakeasyDb.kt`                                |
| `Db/Schema.swift`                        | `db/Schema.kt`                                     |
| `Signal/SpeakeasySignalStore.swift`      | `signal/SpeakeasySignalStore.kt`                   |
| `Signal/SqlCipherSignalProtocolStore.swift` | `signal/SqlCipherSignalProtocolStore.kt`        |

## One-time Xcode setup

These files were authored on a Linux dev box (no `xcodebuild` available).
First build on a Mac requires:

1. **Add the `SpeakeasyBridges` group to the Xcode project**
   - Open `apps/mobile/ios/Speakeasy.xcworkspace`
   - In the Project Navigator, drag the `SpeakeasyBridges` folder
     onto the `Speakeasy` target
   - In the dialog, choose **"Create groups"** + check the **Speakeasy** target
   - Verify each `.swift` and `.m` file has the Speakeasy target checked
     in its File Inspector (right pane → "Target Membership")

2. **Set the Swift bridging header**
   - Speakeasy target → Build Settings → search "bridging header"
   - Set `Objective-C Bridging Header` to:
     `SpeakeasyBridges/Speakeasy-Bridging-Header.h`

3. **Install pods**
   ```sh
   cd apps/mobile/ios
   pod install
   ```
   (Vouchflow + LibSignalClient + SQLCipher pulled in via Podfile.)

4. **Add `Vouchflow.plist`**
   ```sh
   cp Speakeasy/Vouchflow.plist.example Speakeasy/Vouchflow.plist
   # Edit Vouchflow.plist with your real sandbox key
   ```
   Then in Xcode: drag `Vouchflow.plist` onto the Speakeasy target's
   "Copy Bundle Resources" build phase.

5. **Add brand fonts**
   - Place `Inter-{Light,Regular,Medium}.ttf` in `Speakeasy/Fonts/`
   - Drag the folder onto the Speakeasy target's "Copy Bundle Resources"
   - Filenames must match the entries in `Info.plist` `UIAppFonts`

6. **Build**
   ```sh
   xcodebuild -workspace Speakeasy.xcworkspace -scheme Speakeasy \
     -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator'
   ```

## Verification status

✅ **Compile-verified** — 2026-05-18, Xcode 26.4.1, clean simulator
build (see `apps/mobile/ios/HARDENING.md`, Step 0). Every bridge file
compiled without changes: the `// libsignal:` "best guess" API calls
in the Signal / Sender Keys modules turned out correct, and the
CryptoKit-only paths compiled clean as expected.

The build is now CI-gated — `.github/workflows/ios.yml` runs
`pod install` + `xcodebuild` on `macos-latest` for every mobile or
shared-code change, so iOS drift is caught automatically.

## Wire-format compatibility with Android

- ChannelKey wrap/encrypt format: identical bytes (33-byte ephemeral
  pubkey with libsignal 0x05 type prefix, 12-byte AES-GCM IV, ciphertext,
  16-byte tag). HKDF info: `speakeasy-channel-key-wrap-v1`.
- Signal Protocol ciphertext: identical bytes (1-byte type marker
  0x03/0x02 + libsignal-serialized message).
- SQLCipher DB key derivation: identical (HKDF-SHA256 of
  `Vouchflow.shared.cachedDeviceToken`, salt `speakeasy-db-v1`, info
  `sqlcipher-passphrase`, L=32).
- SQLCipher schema: identical (same tables, same migrations v1+v2).
