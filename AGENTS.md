# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- iOS CallKit/PushKit ownership and the required physical-device verification
  live in `apps/mobile/ios/PARITY.md`; keep native and JS call changes aligned
  with that contract.
- The Vouchflow device-confidence floor is set in several coupled places and
  must stay in agreement, or device verification dead-ends: the vouchflow.dev
  dashboard, `MIN_CONFIDENCE` in `packages/vouchflow/src/types.ts`, the server
  default guard in `apps/api/src/{server,production-guard}.ts`, and every
  client `minimumConfidence: 'low'` call site — `apps/mobile/src/auth/{claim-handle,verify-device}.ts`
  and `apps/mobile/src/screens/VerifyGateScreen.tsx`.
- Device verification must not collect email or phone numbers. Unsupported
  devices receive the message in `apps/mobile/src/auth/unsupported-device.ts`.
  Auth requires the native passkey flow; keep enrollment and token-refresh
  behavior aligned with `auth/claim-handle.ts` and `auth/verify-device.ts`.
- `apps/mobile/src/services.ts` must expose Vouchflow's native client directly:
  no layer may answer `verify()` itself. The executable wiring and stale-device
  recovery coverage live in `apps/mobile/src/native/vouchflow-wiring.test.ts`
  and `apps/mobile/src/auth/stale-verification-recovery.test.ts`.
- Automatic re-verification (`launch_refresh`, `websocket_auth_failed`,
  `missing_token`) is rate-limited with an escalating cooldown in
  `apps/mobile/src/auth/verify-device.ts`; that escalating cooldown does not
  apply to user-initiated verification, though the pre-existing 60-second
  cancellation cooldown applies to all reasons. See `verify-device-cooldown.test.ts` for the contract.
- Never pin the `api.vouchflow.dev` leaf certificate or Let's Encrypt's
  issuing intermediates; both platforms pin the ISRG roots. The authoritative
  pin rationale, SDK floor, and platform values live in
  `apps/mobile/ios/SpeakeasyBridges/Vouchflow/VouchflowBootstrap.swift`.
  Preserve the offline parity/fixture-derivation/floor guard in
  `apps/mobile/src/integration/vouchflow-pin-rotation.test.ts` and its weekly
  live-chain workflow at `.github/workflows/vouchflow-pin-check.yml`.
- Coordinated Play releases use Google's ordinary review flow. The Internal
  publish and beta promotion scripts invoked by `release-play.yml` must commit
  without `changesNotSentForReview`; Google rejects that parameter when review
  is automatic. The contract lives in
  `apps/mobile/src/integration/release-pipeline.test.ts`. Keep `:validate` out
  of all Play scripts because `:commit` already validates the atomic edit.
- Pushing a release tag does NOT reach production/App Store on either
  platform — it only reaches the pre-production tracks. A `v*`/`alpha-*` tag
  (`release-play.yml`) publishes to Play Internal then auto-promotes to
  **beta** (Open Testing) only; reaching **production** requires a separate
  manual dispatch: `gh workflow run play-promote.yml -f from_track=beta -f
to_track=production -f release_status=completed` (see `play-promote.yml`'s
  header — this repo's no-review model means `completed` goes live
  immediately, no Google review). Likewise an `ios-*` tag / a plain
  `release-ios.yml` run defaults to `lane=beta` (TestFlight only); the App
  Store Connect build needs `gh workflow run release-ios.yml -f
lane=release`, which builds+uploads only (`submit_for_review: false` in
  `ios/fastlane/Fastfile`'s `release` lane) and never submits to Apple
  review.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
