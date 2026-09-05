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
- Nothing may sit between the app and the Vouchflow native SDK that can
  answer `verify()` on its own. A `CachingVouchflowClient` used to, and it
  permanently locked out every device whose verification aged past the
  server's freshness window: the forced re-verification was served from
  cache, no new Vouchflow row was ever created, and the rejected credential
  was re-presented forever. `apps/mobile/src/native/vouchflow-wiring.test.ts`
  pins the wiring; `apps/mobile/src/auth/stale-verification-recovery.test.ts`
  pins the recovery loop end to end.
- Automatic re-verification (`launch_refresh`, `websocket_auth_failed`,
  `missing_token`) is rate-limited with an escalating cooldown in
  `apps/mobile/src/auth/verify-device.ts`; verifications the user asked for
  are never throttled. Without that brake the WS reconnect ladder (30s cap)
  re-opens the verify sheet indefinitely.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
