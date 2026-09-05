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
- Every device-verification surface (onboarding's `HandleStep`, the returning-
  user `VerifyGateScreen`, and the monthly re-verify `VerifyDeviceSheet`) must
  offer the email-OTP fallback when the passkey/attestation path can't
  complete — never a retry-only dead end. The shared pieces: fallback
  decision + network calls in `apps/mobile/src/auth/claim-handle.ts`
  (`fallbackReasonFor`, `startEmailFallback`, `completeEmailFallbackVerification`)
  and the shared UI in `apps/mobile/src/components/EmailVerifyFallback.tsx`.
  `VerifyDeviceSheet` bridges its passkey attempt to the inline email step via
  `store/verify-sheet.ts`'s `fallback` field rather than closing and reopening
  the sheet — see that file's comments before changing its resolve/reject
  contract.
- `apps/mobile/src/services.ts` must expose Vouchflow's native client directly:
  no layer may answer `verify()` itself. The executable wiring and stale-device
  recovery coverage live in `apps/mobile/src/native/vouchflow-wiring.test.ts`
  and `apps/mobile/src/auth/stale-verification-recovery.test.ts`.
- Automatic re-verification (`launch_refresh`, `websocket_auth_failed`,
  `missing_token`) is rate-limited with an escalating cooldown in
  `apps/mobile/src/auth/verify-device.ts`; that escalating cooldown does not
  apply to user-initiated verification, though the pre-existing 60-second
  cancellation cooldown applies to all reasons. See `verify-device-cooldown.test.ts` for the contract.
- Never pin the `api.vouchflow.dev` **leaf** certificate: it rotates roughly
  every 90 days and every already-shipped build dies with it (this has fired
  once, `352ba1a`). Both platforms pin the Let's Encrypt YE1 + YE2 issuing
  intermediates — `apps/mobile/ios/SpeakeasyBridges/Vouchflow/VouchflowBootstrap.swift`
  (read its header comment before touching the pins; it records the SDK's real
  matching semantics) and
  `apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/MainApplication.kt`.
  On iOS those intermediate pins are only safe on vouchflow/ios-sdk >= 2.5.0,
  which evaluates TLS trust before comparing pins; never downgrade the SPM
  version in `Speakeasy.xcodeproj/project.pbxproj` below that while pinning
  intermediates. `apps/mobile/src/integration/vouchflow-pin-rotation.test.ts`
  enforces iOS/Android pin parity and that SDK floor offline in CI, and
  `.github/workflows/vouchflow-pin-check.yml` re-checks the live chain weekly.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
