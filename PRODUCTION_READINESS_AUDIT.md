# Production Readiness Audit

Date: 2026-05-19
Repo: `/home/chloropine/projects/speakeasy`
Commit audited: `94f62cc harden(android): enable R8 code shrinking for release builds (#41)`

## Verdict

Speakeasy is materially closer to production than it was during the prior audit, but I would still not call the full product production-ready.

For an Android-only limited production or tightly managed beta, the codebase is close after the upstream hardening pass, provided the production secrets are actually provisioned and the release/Tier B gates pass in CI. For a general public launch, the remaining blockers are iOS push parity, operational proof of the production environment, complete release verification, and doc/runbook accuracy.

The largest previous blockers were fixed:

- API production startup now fails closed for major unsafe fallback configuration.
- Mobile no longer persists the Vouchflow device token in AsyncStorage.
- Core token logging now redacts bearer-like tokens.
- `/metrics` is bearer-token gated.
- Android release signing is wired through production keystore secrets.
- R8/minification is enabled for release builds.
- Public-IP cleartext traffic was removed from Android network security config.
- Release publishing now waits for Tier B emulator success.
- Gitleaks secret scanning was added.

## Current Readiness Snapshot

| Area | Status | Notes |
| --- | --- | --- |
| Android limited production | Near-ready with caveats | Release signing, R8, production Vouchflow env, cleartext cleanup, and release gate are implemented. Still needs a clean CI run and real-device production smoke. |
| iOS production | Blocked | iOS builds are CI-gated, but push handling, notification decrypt, rich display, inline reply, and real-device APNs verification remain unimplemented. |
| API production runtime | Improved, needs env proof | Production guard exists. Remaining issue: Firebase Admin credential completeness is not fully guarded or documented. |
| Auth/token storage | Improved | Device token is scrubbed from AsyncStorage and loaded from native secure storage. Direct JS in-memory reads remain scattered but are not the same persistence risk. |
| Logging/observability | Improved | Core device-token logs are redacted and metrics is gated. Admin/event-log token preview behavior still needs tightening. |
| CI/release gates | Improved, partial | Release waits for Tier B. Tier B still runs only a subset of Maestro flows and local verification was blocked by missing dependencies. |
| Database migrations | Partial | Production uses `infra/migrations` via `node-pg-migrate`; Drizzle migration artifacts still exist separately. |
| Docs/runbooks | Blocked for handoff | Several docs describe old alpha/mocked/native-missing behavior and omit new production guard secrets. |
| Legal/app-store | Partial | Privacy/terms/open-source surfaces exist in the app, but repo license is still "To be decided" and app-store disclosure readiness was not verified. |

## Resolved Since Prior Audit

### API no longer silently boots unsafe production fallbacks

`apps/api/src/production-guard.ts` now collects production configuration violations, and `apps/api/src/server.ts` calls `assertProductionConfig()` in `main()` before app startup.

This addresses the previous risk that a production deploy could accidentally run with mock auth, in-memory repos, no Redis, no push, no TURN, low Vouchflow confidence, or exposed metrics.

### Vouchflow device token is no longer persisted in AsyncStorage

`apps/mobile/src/store/identity.ts` now documents and enforces the intended boundary:

- Persisted to AsyncStorage: `userId`, `deviceTokenIssuedAt`.
- Not persisted to AsyncStorage: `deviceToken`.
- Hydrated in memory from native secure storage via `getCachedDeviceToken()`.
- Legacy cleartext `deviceToken` values are scrubbed during `hydrate()`.

`apps/mobile/src/native/cached-device-token.ts` provides the native cached-token reader for JS and headless flows.

### Core token logs are redacted

`apps/api/src/log/redact.ts` adds `redactToken()`.

Core paths now use it:

- `apps/api/src/auth/vouchflow.ts`
- `apps/api/src/ws/handler.ts`
- `packages/vouchflow/src/validator.ts`

### Metrics are protected

When `METRICS_ENABLED=1`, `/metrics` now requires:

```text
Authorization: Bearer <METRICS_TOKEN>
```

If `METRICS_TOKEN` is unset, the endpoint returns 503 instead of exposing metrics openly.

### Android release hardening landed

Release build improvements:

- `enableProguardInReleaseBuilds = true`.
- Release keystore supplied through CI secrets and Gradle properties.
- CI rejects debug-signed release artifacts.
- Release CI passes `-Pvouchflow.environment=production`.
- Cleartext public IP `65.21.224.209` removed; only emulator loopback `10.0.2.2` remains.

### Release publishing now waits for Tier B

`.github/workflows/release.yml` includes a gate job that waits for `tier-b-emulator.yml` to pass for the same commit before the APK publishes.

## Remaining Production Blockers

### P0: iOS push parity blocks any iOS production launch

Evidence:

- `apps/mobile/ios/PARITY.md` says iOS push handling is still absent.
- `apps/mobile/ios/PUSH-PARITY.md` says iOS has zero app-side push handling and needs an NSE/App Group/shared Signal store design.
- `apps/api/src/push/push.fcm-apns.ts` now sets APNs `mutable-content`, but the iOS app side still lacks the Notification Service Extension and decrypt/inline-reply implementation.

Recommendation:

Do not include iOS in production until this is implemented and real-device APNs sandbox/prod testing passes:

1. App Group entitlement for app and NSE.
2. Shared SQLCipher Signal store access.
3. Notification Service Extension decrypt path.
4. Cross-process idempotent decrypt cache.
5. `UNNotificationCategory` inline reply.
6. Rich display intent.
7. Real-device APNs verification.

Android-only launch language should be explicit if Android ships first.

### P0: Production env docs and guard are incomplete for Firebase Admin

Evidence:

- `apps/api/src/production-guard.ts` checks `FCM_PROJECT_ID`.
- `apps/api/src/push/push.fcm-apns.ts` also reads `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY` when creating the Firebase Admin credential.
- `infra/fly/README.md` does not yet document all secrets required by the production guard and push provider.

Risk:

A production app could satisfy `FCM_PROJECT_ID` but still fail push provider initialization because the service-account email or private key is missing/malformed.

Recommendation:

Update `collectProductionConfigErrors()` to require the full Firebase Admin triplet:

- `FCM_PROJECT_ID`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY`

Then update `infra/fly/README.md` with the complete production secret list:

- `DATABASE_URL`
- `REDIS_URL`
- `VOUCHFLOW_READ_KEY`
- `VOUCHFLOW_BASE_URL`
- `FCM_PROJECT_ID`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY`
- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_TOKEN`
- `ADMIN_TOKEN`
- `METRICS_TOKEN`

### P0: Need a clean production-gate verification run

Local verification could not run because dependencies are absent in this checkout:

```text
npm run typecheck -> sh: 1: turbo: not found
npm run lint      -> sh: 1: turbo: not found
npm test          -> sh: 1: turbo: not found
```

Recommendation:

Before claiming production readiness, run in a clean dependency-installed environment:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm audit --audit-level=moderate
```

Then run the Android release workflow and Tier B gate on the exact release tag.

## High-Priority Pre-Production Work

### P1: Tier B does not cover every non-helper Maestro flow

The repo has 17 Maestro YAMLs. The Tier B chain currently runs a hand-picked sequence: `11-push-background-handler` and flows `01` through `08`.

Uncovered non-helper flows include:

- `09-burn-conversation.yaml`
- `10-block-and-unblock.yaml`
- `11-push-handler-simple.yaml`
- `11-push-notifications-background.yaml`
- `11-settings-tree.yaml`
- `12-avatar-store.yaml`

Recommendation:

Create a required-flow manifest or test runner that includes every non-helper flow. Mark helper flows by convention, such as leading `_`, and fail CI if a new required flow is added but not gated.

### P1: Placeholder lint still weakens CI

Root CI calls `npm run lint`, but API, mobile, crypto, and vouchflow package lint scripts still echo "no lint configured yet".

Recommendation:

Add a real lint gate before production. Prioritize rules that catch runtime and security issues:

- React hooks correctness.
- Floating promises.
- Sensitive log fields.
- Raw `console.*` outside allowlisted diagnostics/scripts.
- Unsafe `any` in route dependencies.

### P1: Admin diagnostics still expose more token material than necessary

Core logs are now redacted, but `apps/api/src/routes/admin.ts` still records a 16-character device-token prefix in event-log payloads during device deletion. Admin device-list responses can also return full device and push tokens to any holder of `ADMIN_TOKEN`.

Recommendation:

- Use `redactToken()` in admin event-log payloads.
- Return redacted device records by default.
- Keep full token access behind an explicit, audited break-glass route only if truly needed.
- Factor `ADMIN_TOKEN` auth into one pre-handler so future admin routes do not drift.

### P1: Migrations need a single production source of truth

Production deploy runs:

```sh
npm run db:migrate
```

That uses `node-pg-migrate` over `infra/migrations`. The API package also exposes Drizzle migration commands and has `apps/api/drizzle` artifacts.

Recommendation:

Declare `infra/migrations` canonical and add drift checks, or migrate fully to Drizzle-generated migrations. Do not leave both as plausible production paths without enforcement.

### P1: Docs and runbooks are stale

Stale docs are now an operational risk:

- `README.md` still describes Alpha 0.1 and says production DNS/TLS is coming.
- `apps/mobile/README.md` says native shells are not scaffolded.
- `HANDOFF.md` describes old mock/stub/in-memory behavior.
- `spec.md` has stale carry-overs that conflict with the current implementation.
- `apps/mobile/src/config.ts` has comments about the old public-IP sandbox even though the values are production URLs.

Recommendation:

Refresh docs before any production handoff. Include an explicit "production launch checklist" that matches the guard and release workflows.

### P1: Real-device release smoke is still required

The code has Android release hardening, but production readiness requires a real artifact test:

- Install production-signed APK.
- Confirm it is not debug-signed.
- Confirm Vouchflow production environment is used.
- Enroll, restart, sign out, re-enroll.
- Send and receive direct/group messages.
- Register push, background app, receive notification, inline reply.
- Make a call across Wi-Fi, carrier NAT, VPN, and UDP-blocked network.
- Verify reinstall does not restore ghost state.

## Medium-Priority Hardening

### P2: Tighten release gate to the exact tag/ref

Release waits for a Tier B run by commit SHA. If the same commit has both `main` and tag-triggered Tier B runs, a prior green run for the SHA may satisfy the gate even if the tag-specific run fails later.

Recommendation:

Tighten the gate to the exact tag/ref or promote releases from a `workflow_run` after Tier B succeeds.

### P2: Checksum-pin downloaded CI tools

`secret-scan.yml` version-pins gitleaks, but it downloads a tarball and pipes it to `tar` without checksum verification.

Recommendation:

Verify the release artifact SHA256 before executing it.

### P2: Keep Android backup behavior under release test

`android:allowBackup="true"` remains set, with rules excluding user-keyed storage and AsyncStorage. This is defensible, but it should be tested on every production-signed release because backup behavior is easy to regress.

Recommendation:

Include uninstall/reinstall and device-transfer behavior in release smoke tests.

### P2: Complete app-store/legal readiness

Repo license is still "To be decided" in `README.md`. Privacy, terms, and open-source links exist in the app, and `PrivacyInfo.xcprivacy` exists for iOS, but this audit did not verify app-store disclosure completeness.

Recommendation:

Before public release:

- Decide and commit a license.
- Verify Apple privacy manifest.
- Verify Google Play Data Safety answers.
- Verify encryption/export-compliance answers.
- Verify open-source notices and AGPL/libsignal obligations.
- Verify account deletion/support copy.

## Updated Production Readiness Checklist

### Required before Android limited production

- `npm ci`
- `npm run build`
- `npm run typecheck`
- real `npm run lint`
- `npm test`
- `npm audit --audit-level=moderate`
- gitleaks CI green
- Tier B emulator green on release tag
- Android release workflow green
- Production-signed APK verified as not debug-signed
- Production Vouchflow environment verified in artifact
- Fly production env has all guard-required secrets
- Firebase Admin credential triplet verified
- `/healthz` and `/version` verify the expected SHA after deploy
- `/metrics` returns 401 without token and 200 with `METRICS_TOKEN`
- Push registration and delivery verified on real Android hardware
- TURN credentials verified and calls tested across hostile networks

### Required before iOS production

- All Android limited-production requirements that apply to backend/shared code.
- iOS app-store signing/provisioning workflow.
- Notification Service Extension.
- App Group shared Signal store.
- APNs real-device test.
- Inline reply from iOS notification.
- iOS CallKit end-to-end test.
- iOS app-store disclosure checklist.

## Bottom Line

The upstream hardening work addressed the previous audit's core production security risks. The current state is best described as: close to Android limited production after CI and real-device validation, not ready for full cross-platform production. The remaining blockers are no longer broad architectural gaps; they are specific launch-readiness gaps around iOS push, complete production env proof, release-gate coverage, linting, migrations, and stale operator docs.
