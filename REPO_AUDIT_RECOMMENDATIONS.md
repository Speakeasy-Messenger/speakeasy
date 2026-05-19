# Speakeasy Repo Audit Recommendations

Date: 2026-05-19

## Scope

This audit reviewed the current `/home/chloropine/projects/speakeasy` checkout as a source-grounded repository inspection. No files were modified during the audit itself.

The repo is a substantial private-messenger monorepo, not a scaffold:

- TypeScript/npm workspaces with Turborepo.
- `apps/api`: Fastify API, Vouchflow auth, Drizzle/Postgres repos, Redis-aware WebSocket routing, push, admin, broadcast, and TURN routes.
- `apps/mobile`: React Native 0.76 client with Android and iOS native bridges for Vouchflow, Signal, ChannelKey, GroupMessaging, SQLCipher, push, calls, avatars, diagnostics, and settings.
- `packages/shared`, `packages/crypto`, `packages/vouchflow`: shared wire types, crypto contracts/test fixtures, and Vouchflow server validator/client.
- CI/CD includes API checks, Android build, iOS build, release APK workflow, Fly deploy, push-specific workflows, and Android emulator Maestro E2E.

## Highest-Priority Recommendations

### 1. Stop Persisting Vouchflow Device Tokens in AsyncStorage

`apps/mobile/src/store/identity.ts` persists `deviceToken` in AsyncStorage, while the native SQLCipher DB derives its encryption key from `Vouchflow.cachedDeviceToken` in `apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/db/SpeakeasyDb.kt`.

That weakens the local encryption model: if app-private storage is extracted, the material used to authenticate requests and derive the encrypted DB key is also present in JS-managed storage.

Recommendation:

- Keep `userId` and non-sensitive identity metadata in JS state as needed.
- Keep the Vouchflow device token only in native Vouchflow secure storage.
- Expose a native-backed `getDeviceToken()` path for API and WebSocket calls.
- Update background reply handling so it does not read the token from AsyncStorage.

### 2. Make Production Fail Closed

The server currently has production-shaped silent fallbacks:

- Missing `DATABASE_URL` falls back to in-memory repos in `apps/api/src/server.ts`.
- Missing `REDIS_URL` falls back to single-instance in-memory presence, rate limiting, ack routing, and call buffers.
- Missing FCM config falls back to `NoopPushProvider`.
- `VOUCHFLOW_USE_MOCK=1` activates a mock validator.

These are useful in tests and local demos, but dangerous in production because the app can appear live while losing persistence, cross-instance delivery, or push notifications.

Recommendation:

- Add a production config assertion that runs at API startup.
- In `NODE_ENV=production`, require `DATABASE_URL`, `REDIS_URL`, real Vouchflow config, full FCM credentials, and any required TURN/admin settings.
- Reject `VOUCHFLOW_USE_MOCK=1`, sandbox-only confidence overrides, and no-op push in production.
- Keep in-memory/no-op fallbacks explicitly scoped to tests, local dev, or named sandbox modes.

### 3. Redact Auth Tokens and Sensitive Data in Logs

Several paths log full or near-full device-token data:

- `packages/vouchflow/src/validator.ts` logs the full reputation response on `no_verification`.
- `apps/api/src/auth/vouchflow.ts` logs `deviceToken` with anomaly warnings.
- `apps/api/src/ws/handler.ts` logs `deviceToken` on WebSocket auth.

Recommendation:

- Add a shared redaction helper for Vouchflow device tokens, push tokens, and bearer-like values.
- Log only short tails, short hashes, or boolean presence.
- Avoid logging full upstream Vouchflow reputation payloads unless explicitly scrubbed.

### 4. Harden Android Release Builds Before Store or Production Distribution

`apps/mobile/android/app/build.gradle` still signs release builds with the debug keystore and disables ProGuard/minification.

Recommendation:

- Add a real release signing config backed by CI secrets.
- Fail release builds if release signing secrets are missing.
- Enable minification/shrinking after validating the ProGuard rules for React Native, libsignal, SQLCipher, Firebase, and Vouchflow.
- Keep debug APK distribution separate from any production or store-signed artifact.

### 5. Make Release Publishing Depend on Tier B E2E

Both the release APK workflow and Tier B emulator workflow trigger on `alpha-*` tags. That can allow APK publishing to happen in parallel with, rather than after, emulator validation.

Recommendation:

- Convert release publishing into a workflow that depends on successful Tier B completion.
- Alternatively, make tag creation happen only after Tier B is green on the candidate commit.
- Ensure the published APK always corresponds to a commit that passed workspace checks, Android build, iOS build, and the current emulator chain.

### 6. Clean Up Stale and Contradictory Docs

The documentation has drift:

- `README.md` still references Alpha 0.1 and says production DNS/TLS is coming.
- `apps/mobile/README.md` says native iOS/Android projects are not scaffolded.
- `HANDOFF.md` contains older state, including outdated claims about push, Drizzle repos, iOS, and sandbox deployment.
- `spec.md` is closest to current, but its top carry-over list contradicts the implementation table.

Recommendation:

- Treat `spec.md` as the product/protocol source of truth.
- Refresh `README.md` as the short current project overview.
- Replace or retire stale handoff sections that describe old alpha states.
- Add a short `docs/status.md` or equivalent if ongoing status changes frequently.

### 7. Replace Placeholder Lint With Real Lint and Security Checks

CI runs `npm run lint`, but the API and mobile lint scripts currently only echo `no lint configured yet`.

Recommendation:

- Add ESLint or Biome for TypeScript and React Native.
- Add rules or custom checks for:
  - raw token logging,
  - accidental production mock paths,
  - unhandled promises in critical server paths,
  - unsafe `console.*` in production server code,
  - stale `TODO`/placeholder markers in production surfaces.
- Keep the existing Hermes-banned-globals test; it is valuable and targeted.

### 8. Consolidate Database Migration Workflow

The root package uses `node-pg-migrate` against `infra/migrations`, while `apps/api/package.json` still exposes Drizzle migration commands. Maintaining two migration systems increases schema drift risk.

Recommendation:

- Pick one deploy migration source and document it as canonical.
- If `infra/migrations` is canonical, remove or clearly mark Drizzle migration commands as developer-only/schema-generation-only.
- Add a schema-drift check that compares Drizzle schema expectations against applied SQL migrations.

### 9. Lock Down Metrics Exposure

Fly enables `METRICS_ENABLED=1`, and the API serves `/metrics` on the main listener. If the public app listener exposes metrics, operational internals may be visible to anyone.

Recommendation:

- Move metrics to an internal-only service, or
- Gate `/metrics` behind a scrape token, allowlist, or Fly-private access path.

### 10. Complete iOS Push Parity as a Dedicated Project

`apps/mobile/ios/PUSH-PARITY.md` already has the right shape: APNs mutable-content delivery, Notification Service Extension, App Group storage, shared SQLCipher access, rich display, and inline reply.

Recommendation:

- Treat this as a focused project because the top risk is cross-process Signal ratchet corruption.
- Implement shared idempotent decrypt cache before trying rich notification polish.
- Plan real-device APNs sandbox verification; simulator-only checks are insufficient.

## Secondary Recommendations

- Replace local-only group leave/rename behavior with server-backed endpoints and sync semantics.
- Keep account deletion and wipe flows owner-scoped and exact-ID based.
- Make `ADMIN_TOKEN` checks constant-time and consider rate-limiting admin routes.
- Revisit Android `allowBackup="true"` after confirming backup exclusion coverage across Android versions.
- Add a production config/status endpoint that reports which required subsystems are active without exposing secrets.
- Audit tracked Firebase and Vouchflow config files for intended public/client-safe content.

## Verification Status

Local verification could not run because dependencies were not installed in this checkout.

Commands attempted:

```sh
npm test
npm run typecheck
npm run lint
```

All failed at:

```text
sh: 1: turbo: not found
```

Recommended verification sequence after installing dependencies:

```sh
npm ci
npm run build
npm run typecheck
npm run test
npm run lint
npm audit --audit-level=moderate
```

For mobile/release-sensitive changes, also run the Android/iOS build gates and the Maestro E2E chain before claiming production readiness.
