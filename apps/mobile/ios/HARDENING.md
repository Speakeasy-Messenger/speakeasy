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

### Track 1 — iOS CI gate · IN PROGRESS

- [x] `.github/workflows/ios.yml` drafted — `macos-latest`,
      `pod install` + `xcodebuild` Debug-simulator build gate
- [ ] push + confirm the workflow runs green on GitHub
- [ ] fast-follow: Simulator launch smoke test (needs a
      Release/bundled build — deferred so the build gate lands first)

### Track 2 — quick parity fixes · BLOCKED on Step 0

- [ ] Version Swift module (kills the `0.0.0-test` bug)
- [ ] iOS crash handler in `AppDelegate`
- [ ] cross-platform copy confirmation (the `ToastAndroid` gap in
      `RichMessageText`, introduced rc.106)
- [~] Vouchflow iOS SDK `2.0.0` → `2.1.1` — SPM pin edited in
      `project.pbxproj`; needs Mac re-`pod install` (SPM integration)
      + rebuild to verify

### Track 4 — iOS push parity · BLOCKED on Step 0

- [ ] background push handling
- [ ] Notification Service Extension — on-device decrypt
- [ ] `UNNotificationAction` inline reply

### Audit doc · DONE

- `apps/mobile/ios/PARITY.md`

### Docs refresh · DO LAST (when all tracks land)

Update every doc to match the shipped state:

- [ ] `CLAUDE.md` — fix stale "repo not cloned on the Mac yet";
      refresh the iOS toolchain / libsignal section
- [ ] `apps/mobile/ios/SpeakeasyBridges/README.md` — update the
      "Verification status" section (no longer un-verified) and the
      one-time Xcode setup status
- [ ] `apps/mobile/ios/PARITY.md` — drop the "never compile-verified"
      reality-check note; update the Version-module row and the
      `// 🍎`-deferred markers
- [ ] `apps/mobile/ios/HARDENING.md` — final state
- [ ] `spec.md` — reflect iOS status if it tracks platform state

## Current state

- 2026-05-18: **Step 0 done** — iOS builds clean (first
  compile-verification ever), confirmed with Vouchflow 2.1.1. Track 1
  in progress: `ios.yml` drafted, needs a push to verify.

## Log

- 2026-05-18: created this tracker; PARITY.md audit complete.
- 2026-05-18: Mac had a stale rc.35 clone; reset to rc.106. npm
  install clean. Vouchflow.plist written (sandbox key). pod install
  started.
- 2026-05-18: first iOS build SUCCEEDED on the first try (Vouchflow
  2.0.0) — all 9 SpeakeasyBridges Swift files compiled, no errors.
  Bumped Vouchflow SDK to 2.1.1, re-`pod install`, rebuilt — clean.
  Step 0 complete. Drafted `.github/workflows/ios.yml`.
