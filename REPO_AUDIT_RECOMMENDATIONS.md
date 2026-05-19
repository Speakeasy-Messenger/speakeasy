# Repository Audit Recommendations

Date: 2026-05-19
Repo: `/home/chloropine/projects/speakeasy`
Commit audited: `94f62cc harden(android): enable R8 code shrinking for release builds (#41)`

## Executive Summary

The repo is in a much stronger state than the prior audit. The original high-risk recommendations were largely implemented upstream: production API startup now fails closed, bearer-like tokens are redacted from core logs, the mobile app no longer persists the Vouchflow device token in AsyncStorage, metrics are bearer-token gated, Android release signing is wired through CI secrets, R8 is enabled, the public-IP cleartext exception is gone, secret scanning exists, and release publishing waits for Tier B.

The remaining work is mostly about operational rigor, documentation accuracy, and gate completeness. The top current recommendations are:

1. Refresh stale docs that still describe pre-native, mock, or public-IP alpha behavior.
2. Replace placeholder lint scripts with real linting across API, mobile, and packages.
3. Make Tier B flow coverage explicit and include or intentionally exclude every Maestro flow.
4. Normalize migrations around one production source of truth.
5. Complete deployment/runbook docs for the new required production secrets.
6. Finish iOS push parity or keep production language explicitly Android-only.

## Current Inventory

- Tracked files: 592.
- Core audited source/config files under `apps/api/src`, `apps/mobile/src`, `packages`, `infra`, and `.github`: 356.
- Test files under `apps/api/src`, `apps/mobile/src`, and `packages`: 72 `*.test.ts` files.
- SQL migrations in `infra/migrations`: 17.
- Maestro flows in `apps/mobile/maestro`: 17 YAML files.
- Workflows in `.github/workflows`: Android, iOS, CI/deploy, release, secret-scan, Tier B emulator, and push-test helpers.

Local verification status:

- `git diff --check` passed before report edits.
- `npm run typecheck`, `npm run lint`, and `npm test` could not run because this checkout has no `node_modules`; `turbo` was not found.

## What Improved Since The Prior Audit

### API production hardening landed

`apps/api/src/production-guard.ts` now provides a fail-closed production configuration gate. It blocks production startup when unsafe dev fallbacks would otherwise be used: mock Vouchflow, missing `DATABASE_URL`, missing `REDIS_URL`, missing push configuration, sandbox Vouchflow, low confidence, missing TURN credentials, missing admin token, or metrics enabled without a metrics token.

`apps/api/src/server.ts` calls `assertProductionConfig()` in `main()` before building the Fastify app.

### Device token persistence was fixed

`apps/mobile/src/store/identity.ts` now persists only `userId` and `deviceTokenIssuedAt` to AsyncStorage. It explicitly treats `deviceToken` as a bearer-like native-owned credential, hydrates an in-memory copy from `getCachedDeviceToken()`, and scrubs legacy cleartext tokens from older installs.

`apps/mobile/src/native/cached-device-token.ts` centralizes native cached-token reads for JS and headless paths.

### Token redaction improved

`apps/api/src/log/redact.ts` adds `redactToken()`.

Core auth and WebSocket logs now call it:

- `apps/api/src/auth/vouchflow.ts`
- `apps/api/src/ws/handler.ts`
- `packages/vouchflow/src/validator.ts` avoids dumping the full echoed `device_token` in its no-verification diagnostic.

### Metrics and secret scanning improved

`/metrics` is now protected by `METRICS_TOKEN` when `METRICS_ENABLED=1`; if metrics are enabled without a token, the endpoint fails closed with 503.

`.github/workflows/secret-scan.yml` runs a version-pinned gitleaks CLI scan, and `.gitleaks.toml` documents the Firebase client-config allowlist.

### Android release hardening improved

Android release builds now:

- Enable R8/minification in `apps/mobile/android/app/build.gradle`.
- Support production keystore secrets through `RELEASE_*` Gradle properties.
- Fail release CI if the APK is debug-signed.
- Pass `-Pvouchflow.environment=production` in release CI.
- Remove the previous public-IP cleartext network exception, leaving only emulator loopback `10.0.2.2`.

### Release gating improved

`.github/workflows/release.yml` now has a `gate` job that waits for Tier B emulator success before publishing the APK asset.

## Highest-Priority Recommendations

### 1. Refresh stale docs before the next handoff

Severity: High

Several docs now contradict the current codebase:

- `README.md` still says "Alpha 0.1" and says production DNS/TLS is coming, while `apps/mobile/src/config.ts` points to `https://api.speakeasyapp.xyz`.
- `apps/mobile/README.md` still says native iOS/Android projects are not scaffolded and describes `DevVouchflowClient` / HMAC stub behavior.
- `HANDOFF.md` describes a May 1 alpha state with mock Vouchflow, in-memory or stubbed production pieces, and old release practices.
- `spec.md` has a current status row, but its "Open carry-overs" still says native shells are not generated and native modules throw `not_implemented`.
- `apps/mobile/src/config.ts` has stale comments about a dev sandbox public IP even though the values are production DNS/TLS URLs.

Recommendation:

Make `README.md`, `apps/mobile/README.md`, `HANDOFF.md`, `spec.md`, and `apps/mobile/src/config.ts` comments match the current implementation. This is now the single biggest non-code risk because the repo behavior changed substantially after the hardening commits.

### 2. Replace placeholder lint scripts

Severity: High

The root CI runs `npm run lint`, but multiple package lint scripts are still placeholders:

- `apps/api/package.json`: `echo 'no lint configured yet'`
- `apps/mobile/package.json`: `echo 'no lint configured yet'`
- `packages/crypto/package.json`: `echo 'no lint configured yet'`
- `packages/vouchflow/package.json`: `echo 'no lint configured yet'`

There is also no ESLint, Biome, or equivalent configured in package manifests. TypeScript strictness is strong, but it does not cover sensitive logging, floating promises, import hygiene, React hook rules, or dead branches.

Recommendation:

Add a real lint gate across API, mobile, and packages. At minimum, enforce:

- React Hooks rules for mobile.
- No raw `console.*` in production code except allowlisted scripts/diagnostics.
- No full token fields in logs or event-log payloads.
- No floating promises except explicitly documented fire-and-forget paths.
- No placeholder `any` in route dependencies where typed repo interfaces exist.
- No stale `not_implemented` references in current docs.

### 3. Make Tier B coverage complete or explicitly scoped

Severity: High

There are 17 Maestro YAMLs, but the Tier B chain currently runs a smaller hand-written subset:

- Runs: `11-push-background-handler`, `01` through `08`.
- Not run by the chain: `09-burn-conversation`, `10-block-and-unblock`, `11-push-handler-simple`, `11-push-notifications-background`, `11-settings-tree`, `12-avatar-store`, plus helper flows.

Recommendation:

Add a manifest such as `apps/mobile/maestro/required-flows.txt` or a script that discovers and runs all non-helper flows, with explicit exclusions for helper files. The release gate is only as strong as the flows it actually executes.

### 4. Normalize database migrations

Severity: Medium-High

There are two migration surfaces:

- Production/root: `node-pg-migrate` over `infra/migrations`.
- API package: Drizzle commands and generated files under `apps/api/drizzle`.

The Fly release command uses the root `db:migrate` script, so `infra/migrations` is production truth today. The Drizzle migration output can drift unless intentionally declared non-production.

Recommendation:

Document and enforce one canonical path:

- If SQL migrations are canonical, keep Drizzle for schema/types only and add a drift check.
- If Drizzle migrations become canonical, remove or regenerate `infra/migrations` through that path and update Fly release commands.

### 5. Update production deployment docs for the new guard

Severity: Medium-High

`infra/fly/README.md` still lists only a small subset of required secrets. The production guard now requires more configuration than the docs describe, including:

- `DATABASE_URL`
- `REDIS_URL`
- `VOUCHFLOW_READ_KEY`
- `VOUCHFLOW_BASE_URL`
- `FCM_PROJECT_ID`
- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_TOKEN`
- `ADMIN_TOKEN`
- `METRICS_TOKEN` when metrics are enabled

The push provider also needs Firebase service-account details (`FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY`), but the production guard currently checks only `FCM_PROJECT_ID`.

Recommendation:

Update `infra/fly/README.md` and production setup docs so an operator can set every required secret without reading source. Also expand the production guard to validate complete Firebase Admin credentials, not just `FCM_PROJECT_ID`.

### 6. Tighten admin route redaction and auth structure

Severity: Medium

The main auth/WS logs now use `redactToken()`, but `apps/api/src/routes/admin.ts` still records a 16-character device-token prefix in the event log when deleting devices. Admin list endpoints can also return full device records, including `deviceToken` and `pushToken`, to any holder of `ADMIN_TOKEN`.

Recommendation:

- Use `redactToken()` in admin event logs too.
- Consider redacted response shapes for admin list endpoints by default, with a separate explicit break-glass mode if full tokens are ever needed.
- Factor the repeated `ADMIN_TOKEN` checks into one pre-handler.

### 7. Centralize mobile device-token access for call sites

Severity: Medium

The persistence fix is good: AsyncStorage no longer stores `deviceToken`. However, many UI and service call sites still read `useIdentity.getState().deviceToken` directly. This keeps the token transiently in JS memory, which is expected, but the access pattern is scattered and can produce inconsistent fallback behavior when hydration has not loaded the native cached token yet.

Recommendation:

Add a single mobile auth helper, for example `getDeviceToken({ forceRefresh })`, and migrate direct store reads over time. That helper can:

- Prefer the in-memory token.
- Fall back to native `getCachedDeviceToken()`.
- Trigger `vouchflow.verify()` only when necessary.
- Persist only freshness metadata.
- Register push after token refresh.

### 8. Add checksum pinning for downloaded CI tools

Severity: Medium

`secret-scan.yml` downloads a version-pinned gitleaks tarball over TLS and pipes it into `tar`. Version pinning is good, but checksum verification would close the remaining supply-chain gap.

Recommendation:

Pin the SHA256 for the gitleaks release artifact or use a trusted setup action with pinned commit SHA and no license requirement.

## Secondary Recommendations

### Improve release gate identity

The release workflow waits for the most recent Tier B run by commit SHA. If the same SHA has both main and tag runs, the gate may observe a successful run that is not the tag-triggered run. This is probably acceptable for now because the workflow is the same, but it is worth tightening to the exact tag/ref or using a `workflow_run`-style promotion path.

### Add local bootstrap docs

The repo has `package-lock.json`, `.nvmrc`, and npm workspaces, but this checkout had no `node_modules`, so local test/typecheck/lint commands failed at `turbo: not found`. Add a short "fresh checkout" section:

```sh
npm ci
npm run build
npm run typecheck
npm run test
```

### Add dependency/security gates beyond secret scanning

Once dependency installation is available in CI and locally, add:

```sh
npm audit --audit-level=moderate
```

For mobile native dependencies, periodically review Gradle/CocoaPods resolved dependency versions and update policy.

### Keep generated/native comments current

There are several stale comments in docs and source headers. These do not change runtime behavior, but in a security-sensitive app they create operational risk because future maintainers may make decisions based on old assumptions.

## Verification Notes

Commands attempted locally:

```sh
git diff --check
npm run typecheck
npm run lint
npm test
```

Results:

- `git diff --check` passed before these report edits.
- `npm run typecheck`, `npm run lint`, and `npm test` all failed immediately with `sh: 1: turbo: not found` because dependencies are not installed in this checkout.

## Bottom Line

The repo has absorbed the previous audit's most important security hardening work. The next highest leverage pass is not another security patch; it is making the repo's gates and documentation match the hardened code. The codebase is strong enough that stale docs, partial linting, incomplete E2E coverage, and migration ambiguity are now the main ways future regressions can slip through.
