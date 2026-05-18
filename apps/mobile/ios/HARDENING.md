# iOS hardening — progress tracker

Living state for the iOS testing & hardening initiative (started
2026-05-18). **This file survives context resets** — update _Status_
and _Log_ as work proceeds so progress is never lost.

Companion to `PARITY.md` (the divergence audit).

## Goal

Take iOS from "never compiled" to a tested, hardened, CI-gated app that
tracks Android automatically.

## Phases

### Step 0 — first clean iOS build · DONE

Prerequisite for everything else; the iOS Swift layer has never been
compile-verified.

- [x] repo on the Mac at rc.106 — it had a stale rc.35 copy at
      `~/speakeasy` (CLAUDE.md's "not cloned yet" was wrong); brought
      current with `git fetch && git reset --hard 98f167e`
- [x] `npm install` on the Mac (node 25.9)
- [x] `Vouchflow.plist` created from `Vouchflow.plist.example`
- [x] `pod install` (`USE_FRAMEWORKS=static`, libsignal v0.59.0
      prebuild) — 94 pods, Vouchflow SPM integrated
- [x] `xcodebuild` simulator build
- [x] triage compile errors — **none.** Built clean on the first
      try; all 9 `SpeakeasyBridges` Swift files compiled (the
      README's "expect signature fixes" warning was unwarranted)
- [x] **FIRST CLEAN BUILD** ✅ — `Speakeasy.app` produced
      (Debug-iphonesimulator), `** BUILD SUCCEEDED **` (Vouchflow 2.0.0)
- [x] re-verified — clean build with Vouchflow SDK 2.1.1 (SPM
      resolved `2.1.1`, `** BUILD SUCCEEDED **`)

#### Mac build environment (for resuming)

- Host: `ssh dani@macbook-pro-7` · repo: `~/speakeasy` · Xcode 26.4.1
- Brew tools are NOT on the non-interactive SSH `PATH` — prefix every
  command with `export PATH=/usr/local/bin:$PATH`
- node 25.9, npm, pod, rsync all under `/usr/local/bin`
- libsignal prebuild cached at
  `~/Library/Caches/org.signal.libsignal/libsignal-client-ios-build-v0.59.0.tar.gz`
- Build cmd: `xcodebuild -workspace Speakeasy.xcworkspace -scheme
  Speakeasy -configuration Debug -sdk iphonesimulator
  -destination 'generic/platform=iOS Simulator'`

### Track 1 — iOS CI gate · DONE

- [x] `.github/workflows/ios.yml` — `macos-latest`, `pod install` +
      `xcodebuild` Debug-simulator build gate
- [x] verified green on GitHub (run 26035467274, passed first try)
- [ ] fast-follow: Simulator launch smoke test (needs a
      Release/bundled build — deferred so the build gate lands first)

### Track 2 — quick parity fixes · DONE

- [x] Vouchflow iOS SDK `2.0.0` → `2.1.1`
- [x] cross-platform copy confirmation — `<Toast>` (`store/toast.ts` +
      `components/Toast.tsx`, mounted in `RootNavigator`) replaces the
      Android-only `ToastAndroid`
- [x] iOS crash handler — `AppDelegate.mm` installs an
      `NSSetUncaughtExceptionHandler` that writes a timestamped report
      to the app's Documents dir (catches RN's RCTFatal path)
- [x] Version Swift module (`SpeakeasyBridges/Version/`) — iOS reports
      a real bundle version instead of `0.0.0-test`; `version.ts` reads
      the `SpeakeasyVersion` native module on both platforms

All four verified by a clean iOS build on the Mac.

### Track 4 — iOS push parity · SPEC'D, not built

Full design in `PUSH-PARITY.md`. Deferred as its own focused project:
it needs a new NSE Xcode target, an App Group, a server payload
change, and real-device APNs testing to verify.

- [ ] APNs `mutable-content` delivery (server)
- [ ] Notification Service Extension — on-device decrypt
- [ ] App Group + shared Signal store
- [ ] `UNNotificationAction` inline reply + rich display

### Audit doc · DONE

- `apps/mobile/ios/PARITY.md`

### Docs refresh · DONE (2026-05-18, post Steps 0–2)

Refreshed to match the shipped state:

- [x] `CLAUDE.md` — repo-on-Mac reality, SSH `PATH` quirk, libsignal
      settings now committed, new iOS build-status section
- [x] `apps/mobile/ios/SpeakeasyBridges/README.md` — verification
      status updated (it builds)
- [x] `apps/mobile/ios/PARITY.md` — rewritten for post-hardening state
- [x] `apps/mobile/ios/HARDENING.md` — this file
- [x] `spec.md` — iOS compile-verified + CI status

## Current state

- 2026-05-18: **Steps 0–2 done; Track 4 spec'd.** iOS builds clean,
  is CI-gated, and is at parity on version reporting, crash capture,
  copy feedback, and the Vouchflow SDK. Push parity (Track 4) is fully
  designed in `PUSH-PARITY.md` — deferred as its own focused project.
  Docs refreshed. The initiative is parked at a clean milestone.

## Log

- 2026-05-18: created this tracker; PARITY.md audit complete.
- 2026-05-18: Mac had a stale rc.35 clone; reset to rc.106. npm
  install clean. Vouchflow.plist written (sandbox key). pod install
  started.
- 2026-05-18: first iOS build SUCCEEDED on the first try (Vouchflow
  2.0.0) — all 9 SpeakeasyBridges Swift files compiled, no errors.
  Bumped Vouchflow SDK to 2.1.1, re-`pod install`, rebuilt — clean.
  Step 0 complete. Drafted `.github/workflows/ios.yml`.
- 2026-05-18: `ios.yml` verified green on GitHub (Track 1 done).
  Track 2: copy `<Toast>`, AppDelegate crash handler, and the Version
  native module — registered via the `xcodeproj` gem and verified by
  a clean iOS build. Note: after a `git reset --hard` on the Mac,
  always re-run `pod install` (it reverts `Podfile.lock`).
- 2026-05-18: Track 4 (push parity) designed — see `PUSH-PARITY.md`;
  deferred as a separate project (needs an NSE target + device APNs
  testing). Docs refreshed across `CLAUDE.md`, `spec.md`, `PARITY.md`,
  and the `SpeakeasyBridges` README. Initiative parked at a clean
  milestone: iOS builds, is CI-gated, and is at parity except push.
