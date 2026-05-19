# Production Readiness Audit

Date: 2026-05-19  
Repo: `/home/chloropine/projects/speakeasy`

## Verdict

Speakeasy is not production-ready yet.

The repo is substantially beyond a prototype: it has real API routes, Postgres-backed repositories, Redis-backed cross-instance primitives, Fly deployment config, Android release automation, native crypto/storage modules, and emulator E2E coverage. The remaining readiness risk is not "missing app"; it is production hardening. The highest-risk gaps are fail-open production configuration, bearer-like device token handling, release gating, Android release hardening, and iOS push parity.

I would treat the current state as an alpha or internal/bounded Android test build, not a public production launch.

## Audit Scope

Reviewed:

- API runtime wiring under `apps/api/src/`
- Mobile app runtime, identity, push, native Android/iOS setup under `apps/mobile/`
- CI/release workflows under `.github/workflows/`
- Deployment config under `infra/fly/`
- Database migrations under `infra/migrations/` and API Drizzle config
- Product/docs drift in `README.md`, `apps/mobile/README.md`, `spec.md`, and `HANDOFF.md`
- Secret/config exposure patterns with source scans

Local build/test verification was not completed because this checkout does not have installed dependencies; `turbo` was unavailable when the repo-level npm scripts were attempted.

## Readiness Snapshot

| Area | Status | Production concern |
| --- | --- | --- |
| API runtime | Blocked | Production can silently fall back to in-memory repos, single-instance presence, no-op push, STUN-only calls, and relaxed Vouchflow confidence depending on env. |
| Auth and device identity | Blocked | Vouchflow `deviceToken` is persisted in JS AsyncStorage and logged in multiple server/client paths. It acts like a bearer credential and is also used in DB key derivation. |
| Android release | Blocked | Release build still signs with the debug keystore, ProGuard/minify is disabled, sandbox defaults remain easy to ship, and cleartext network config includes a public IP. |
| iOS release | Blocked for iOS | Native modules now compile, but iOS still has zero app-side push handling, no notification decryption path, and no inline reply parity. |
| CI and release automation | Partial | CI exists and release builds are automated, but release publishing is independent from the Tier B emulator gate despite comments saying it blocks release tags. |
| API deployment | Partial | Fly deploy has health/version verification and release migrations, but runtime hardening and metrics exposure need tightening. |
| Data migrations | Partial | There are two migration surfaces: root `node-pg-migrate` SQL migrations and API Drizzle migration commands. This needs one canonical production path. |
| Observability | Partial | Health/version endpoints exist. Metrics exist when enabled, but `/metrics` mounts on the main listener and needs access control or internal-only exposure. |
| Legal/app-store readiness | Partial | Privacy artifacts exist in places, but license is still undecided and app-store/security disclosures need a formal checklist. |
| Documentation | Blocked for ops handoff | Several docs are stale enough to mislead an operator about native shells, mocks, in-memory behavior, and current release posture. |

## P0 Production Blockers

### 1. Add an API production configuration gate

Evidence:

- `VOUCHFLOW_USE_MOCK=1` activates `MockValidator.alwaysSucceeds()` in `apps/api/src/server.ts:111-115`.
- Missing `DATABASE_URL` falls back to in-memory user, prekey, group, community, device, event-log, and message repos in `apps/api/src/server.ts:157-166` and `apps/api/src/server.ts:209-231`.
- Missing `REDIS_URL` falls back to in-memory presence, rate limiting, ack routing, call buffering, ack buffering, and local user notification in `apps/api/src/server.ts:305-360`.
- Missing `FCM_PROJECT_ID` falls back to `NoopPushProvider` in `apps/api/src/server.ts:363-373`.
- Missing Cloudflare TURN env falls back to public STUN-only credentials in `apps/api/src/routes/turn.ts:129-142`.
- Vouchflow sandbox base URL relaxes the confidence floor to `low` unless overridden in `apps/api/src/server.ts:127-139`.

Recommendation:

Add a startup guard such as `assertProductionConfig()` and call it before `buildServer()` completes when `NODE_ENV=production` or a production Fly app name is detected.

It should fail startup if:

- `VOUCHFLOW_USE_MOCK=1`
- `DATABASE_URL` is missing
- `REDIS_URL` is missing
- FCM/APNs credentials are incomplete
- Cloudflare TURN credentials are missing for production calls
- Vouchflow base URL points at sandbox for a production app
- `VOUCHFLOW_MIN_CONFIDENCE` is below `medium`
- any required admin/broadcast secrets are missing for enabled features

Keep in-memory and no-op fallbacks available for tests/dev, but make them impossible to ship accidentally.

### 2. Stop persisting the Vouchflow device token in JS AsyncStorage

Evidence:

- `apps/mobile/src/store/identity.ts:11-16` documents persisting `deviceToken`.
- `apps/mobile/src/store/identity.ts:57-66` includes `deviceToken` in the persisted shape and writes it with AsyncStorage.
- `apps/mobile/src/store/identity.ts:87-105` persists and hydrates the token.
- Android SQLCipher setup derives its DB key from the cached Vouchflow device token in `apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/db/SpeakeasyDb.kt`.
- `apps/mobile/src/App.tsx` reuses the cached token for launch verify and API/WebSocket auth.

Why this blocks production:

The device token is used as an authentication credential and participates in local data protection. Storing it in JS AsyncStorage broadens the attack surface and undermines the native secure-storage boundary implied by the Vouchflow SDK.

Recommendation:

- Persist only non-secret identity metadata in JS state, such as `userId` and token freshness metadata if needed.
- Read the current device token from native Vouchflow secure storage through a small native bridge when making authenticated requests.
- Clear any existing AsyncStorage token during migration.
- Add a regression test or runtime assertion that `speakeasy.identity.v1` never contains `deviceToken`.

### 3. Redact bearer-like tokens from logs

Evidence:

- `packages/vouchflow/src/validator.ts` logs the no-verification reputation payload, which can include `device_token`.
- `apps/api/src/auth/vouchflow.ts` logs full `deviceToken` on anomaly flags.
- `apps/api/src/ws/handler.ts` logs `deviceToken` on authenticated WebSocket events and on handler errors.

Recommendation:

- Introduce a shared redaction helper for device tokens, push tokens, admin tokens, and TURN credentials.
- Prefer stable hashes or short previews only when correlation is needed.
- Add lint/test coverage for known sensitive field names in structured logs.
- Treat existing logs as potentially sensitive and rotate/expire any production log sinks if these paths have run against real users.

### 4. Harden the Android production build

Evidence:

- Release builds still use `signingConfigs.debug` in `apps/mobile/android/app/build.gradle:319-329`.
- ProGuard/minification is disabled in `apps/mobile/android/app/build.gradle:165-168`.
- `VOUCHFLOW_ENVIRONMENT` defaults to `sandbox` in `apps/mobile/android/app/build.gradle:304-306`.
- `apps/mobile/android/app/src/main/res/xml/network_security_config.xml:10-19` permits cleartext traffic to `65.21.224.209` and `10.0.2.2`.
- Android backup rules intentionally exclude user-keyed state in `backup_rules.xml` and `data_extraction_rules.xml`, which is good, but `AndroidManifest.xml` still needs a final production decision around `allowBackup`.

Recommendation:

- Replace debug signing with a release keystore supplied through CI secrets.
- Add a CI guard that release artifacts cannot be signed with the debug certificate.
- Split debug/sandbox and production flavors so sandbox Vouchflow/API config cannot ship in a production artifact.
- Remove the public-IP cleartext exception before production. Keep emulator-only config in a test/debug source set if needed.
- Enable shrinking/minification only after validating React Native, libsignal, SQLCipher, Firebase, and Vouchflow keep rules.
- Confirm backup policy with an install/uninstall/reinstall test on a production-signed build.

### 5. Make release publishing depend on the real gate set

Evidence:

- `.github/workflows/ci.yml:24-37` runs install, build, typecheck, lint, and tests.
- `.github/workflows/ci.yml:50-123` deploys API on main and verifies `/healthz` plus `/version` SHA.
- `.github/workflows/release.yml:56-81` builds a release APK and checks type/test before publishing.
- `.github/workflows/tier-b-emulator.yml:3-10` says Tier B blocks release-tag builds, but the release workflow has no dependency on that workflow.
- `.github/workflows/tier-b-emulator.yml:149-194` runs a chained Android emulator suite, but this chain does not cover every Maestro YAML in `apps/mobile/maestro/`.

Recommendation:

- Make release publication wait for CI, Android, iOS, and Tier B emulator gates on the exact tag/SHA.
- If cross-workflow dependencies are awkward, publish releases as drafts and promote only after all required checks pass.
- Add an explicit "required flows" manifest for Maestro so new flows cannot be silently excluded from Tier B.
- Add empty-secret guards wherever secrets are required for release-like builds.

### 6. Finish iOS push parity before any iOS production launch

Evidence:

- `apps/mobile/ios/PARITY.md:54-60` states that push handling is Android-only and iOS has zero app-side push handling.
- `apps/mobile/ios/PARITY.md:77-83` ranks push notifications as the top iOS gap.
- `apps/mobile/ios/PUSH-PARITY.md:12-22` says iOS currently shows only the plain alert and lacks decrypt/rich display/inline reply.
- `apps/mobile/ios/PUSH-PARITY.md:90-101` identifies cross-process Signal ratchet corruption and real-device APNs verification as key risks.

Recommendation:

- Do not launch iOS production until the Notification Service Extension, App Group Signal store access, decrypt path, notification category, inline reply, and real-device APNs verification are complete.
- Keep Android-only production/beta language explicit if Android ships first.

## P1 Before Public Beta Or Limited Production

### Replace placeholder lint gates with real linting

Evidence:

- `apps/api/package.json` has a placeholder `lint` script.
- `apps/mobile/package.json` has a placeholder `lint` script.
- Root CI calls `npm run lint`, but placeholders can make the gate look stronger than it is.

Recommendation:

Configure ESLint or the repo-standard linter for API, mobile, and packages. Fail CI on warnings that indicate runtime risk: unhandled promises, unsafe `any`, floating promises, unused env branches, and console logging of sensitive objects.

### Choose one canonical migration workflow

Evidence:

- Root `package.json` runs SQL migrations through `node-pg-migrate` under `infra/migrations`.
- `apps/api/package.json` exposes Drizzle migration/generate/push commands.
- `infra/migrations/` and `apps/api/drizzle/` both contain migration artifacts.

Recommendation:

Pick one production migration source of truth and make CI check that schema definitions, generated SQL, and applied migrations are not drifting. Avoid `drizzle push` in production workflows.

### Lock down metrics exposure

Evidence:

- `infra/fly/api.toml` enables `METRICS_ENABLED=1`.
- `apps/api/src/server.ts:248-255` mounts `/metrics` on the main Fastify listener when enabled.

Recommendation:

Confirm Fly routing makes `/metrics` internal-only, or add authentication/network allowlisting. A public Prometheus endpoint can leak route names, counts, labels, process details, and traffic shape.

### Add automated secret scanning

Evidence:

- No obvious server private key was found in source scans.
- `apps/mobile/android/app/google-services.json` is tracked, which is normal for Firebase clients but still requires Google Cloud API restrictions.
- `.env` files are ignored, and Android local properties are ignored.

Recommendation:

Add a CI secret scanner such as gitleaks or trufflehog. Also restrict Firebase API keys by package name/SHA and monitor for accidental Vouchflow/Firebase/Admin token commits.

### Validate calls on real networks

Evidence:

- Cloudflare TURN support exists in `apps/api/src/routes/turn.ts:53-98`.
- Production without Cloudflare TURN env falls back to STUN-only in `apps/api/src/routes/turn.ts:129-142`.
- iOS CallKit is noted as declared but not end-to-end verified in `apps/mobile/ios/PARITY.md:69-83`.

Recommendation:

Before production call features are advertised, test Android/Android, Android/iOS, and iOS/iOS across home NAT, mobile carrier NAT, VPN, and blocked-UDP networks. Confirm TURN-over-TLS/443 works and credentials are short-lived.

### Refresh operator-facing docs

Evidence:

- `README.md` still frames production DNS/TLS as coming soon in parts.
- `apps/mobile/README.md` says native shells are not scaffolded and references old Vouchflow/HMAC stub flows.
- `spec.md` contains stale carry-overs that conflict with current native and server implementation.
- `HANDOFF.md` describes older alpha behavior including mocks, stubbed push, and missing Drizzle paths.

Recommendation:

Refresh the docs before any handoff or production launch. The docs should clearly state:

- Which environment is production, sandbox, and local dev
- Which credentials are required
- Which release workflow publishes user-visible builds
- Which smoke tests must pass before promotion
- Which features are Android-only versus iOS-ready

## P2 Hardening And Operational Polish

- Add a production canary script that verifies enrollment, authenticated API calls, WebSocket auth, push registration, TURN credential minting, and `/version` SHA after deploy.
- Add a runbook for Fly rollback, DB migration rollback policy, Redis outage behavior, push provider outage behavior, and Vouchflow outage behavior.
- Add dependency audit gates after dependencies install reliably: `npm audit --audit-level=moderate` plus native dependency review for Android/iOS.
- Add a privacy/security review for device attestation, push payload metadata, local SQLCipher key derivation, crash logs, diagnostics export, and support tooling.
- Finalize licensing. `README.md` still says the license is to be decided, which blocks clean public production distribution.
- Prepare app-store disclosures: privacy nutrition labels, data safety, cryptography/export answers, open-source notices, permissions rationale, and account deletion/support flows.

## Recommended Remediation Order

1. Add API production config fail-closed checks.
2. Remove JS persistence of the Vouchflow device token and migrate existing AsyncStorage state.
3. Redact sensitive tokens from all structured logs.
4. Harden Android release signing, environment selection, and cleartext network config.
5. Make release publishing wait for all required gates.
6. Decide whether first public production is Android-only. If iOS is included, build and verify iOS push parity first.
7. Normalize migrations to one production workflow.
8. Replace placeholder lint scripts with real linting.
9. Lock down `/metrics` exposure.
10. Refresh README, mobile README, spec carry-overs, and handoff docs.
11. Run full verification in a clean dependency-installed environment.

## Production Verification Checklist

Run this only after the P0 fixes are in place:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run test
npm audit --audit-level=moderate
```

Android:

```sh
cd apps/mobile/android
./gradlew :app:assembleRelease --no-daemon -Pvouchflow.apiKey="$VOUCHFLOW_WRITE_KEY" -Pvouchflow.environment=production
```

Required manual/device checks:

- Production-signed Android install, cold launch, enroll, restart, sign out, re-enroll.
- Push registration, background push decrypt/display, inline reply, foreground message receipt.
- 1:1 call setup over Wi-Fi, carrier network, VPN, and UDP-blocked network.
- API deploy to staging or production with `NODE_ENV=production` and all required env vars present.
- Fly release migration succeeds and rollback path is documented.
- `/healthz` and `/version` externally verify the expected SHA.
- `/metrics` is not publicly readable unless intentionally authorized.
- No logs contain full device tokens, push tokens, admin tokens, or TURN credentials.
- App reinstall does not restore user-keyed ghost state.
- iOS real-device APNs/NSE/inline-reply test if iOS is in scope.

## Bottom Line

The production readiness path is straightforward but nontrivial. The highest leverage fix is to make production fail closed: once the API refuses to boot with dev/no-op/in-memory fallbacks, the remaining mobile and release work becomes easier to verify. The second most important fix is the device-token handling cleanup, because it is both an authentication risk and a local data-protection risk.

