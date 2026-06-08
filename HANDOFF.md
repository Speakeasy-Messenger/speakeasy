# Speakeasy — handoff to Goose

Authored 2026-05-01 at the alpha-0.2.10 cut, after ~14 release iterations
through alpha-0.1.0 → alpha-0.2.10. This document tells you (a) what
exists, (b) what's broken or unfinished, (c) how to keep moving without
re-discovering every gotcha I tripped over, and (d) the workflow rules
the human has set for you.

If you read nothing else, read **§Working agreement** — that's the
human's expectation of how you should operate.

## Working agreement

**Orchestration model.** Use Claude (the model you're hosted under) for
top-level planning, code review, architecture decisions, and anything
that benefits from sustained context. Spawn GLM subagents (via the Agent
tool with `subagent_type: general-purpose` if no specialised type is
configured for GLM) for **discrete tasks** — file searches, focused
implementation chunks, log triage, test authoring for a specific
module. Keep your own context window for the through-line.

**Branching.** All work goes onto a `staging` branch. **Do not commit
to `main` directly.** When the human is ready to cut a release they'll
merge `staging` → `main` and tag (`git tag alpha-X.Y.Z && git push
--tags`); CI takes it from there. Day-to-day:

```sh
git checkout -b staging       # if it doesn't already exist locally
git pull origin staging       # if it does
# … work, commit …
git push origin staging
```

The release workflow (`.github/workflows/release.yml`) only fires on
`alpha-*` tags pushed to `main`. The Tier-B workflow
(`.github/workflows/tier-b-emulator.yml`) fires on push to `main` AND
on every `alpha-*` tag. The standard CI workflow (`.github/workflows/ci.yml`)
fires on every push and every PR — that's where Tier A lives. **Open a
PR from `staging` → `main`** so CI runs on your work before merge; the
human reviews and merges.

**Quality bar at each spec milestone.** The spec (`spec.md`) is divided
into **Phases 0–5+**. Most early phases are done; track the implementation
status table at the top. **At every major milestone you complete:**

1. Write thorough Tier A integration tests (Node-side, against
   in-memory fixtures + the actual mobile JS modules). They live under
   `apps/mobile/src/integration/` or `apps/api/src/**/*.test.ts`.
2. Write a Maestro Tier B flow (`apps/mobile/maestro/NN-name.yaml`)
   that exercises the same behaviour on a real Android emulator
   end-to-end, then add it to the chain in
   `.github/workflows/tier-b-emulator.yml`.
3. **Iterate until both tiers are green.** Do not move on with red
   tests. Tier B failures often need 5–10 cycles before they pass —
   that's normal; each cycle either fixes a real bug or a test-scaffold
   issue. Each Tier B run takes ~12-15 min cold, ~7 min warm.

The previous owner (me) earned this rule the hard way — three alphas
shipped with a bug Tier A would have caught had it existed.

## Project state — what exists

### Working

- **1:1 chat (direct).** Send + receive verified end-to-end on a real
  Android emulator (Tier B flow `02-self-dm.yaml` green as of run
  25214715546). Encryption is libsignal native via the Kotlin bridge in
  `apps/mobile/android/app/src/main/java/xyz/speakeasyapp/app/signal/`.
  Server relays opaque ciphertext, fans out to multi-device, ack-on-delete.
- **Self-DM** ("Notes to self") via the same code path with a libsignal
  bypass — ChatScreen detects `peerId === myUserId` and sends utf-8
  plaintext on the wire (server is opaque to ciphertext anyway).
- **Group chat** create + send. Bug from 0.2.8 (`api.createGroup`
  sending `content-type: application/json` with no body, Fastify 400'd)
  fixed in 0.2.10. Flow `05-group-create.yaml` covers it.
- **Identity persistence.** AsyncStorage-backed `useIdentity` store;
  app survives kill/relaunch.
- **Conversation history persistence.** AsyncStorage-backed
  `useConversations` store. TTL respected on hydrate (expired messages
  filter out so we don't resurrect them).
- **On-device crash logger.** `MainApplication.installCrashWriter()`
  catches uncaught Java/Kotlin throwables and writes timestamped files
  to `/sdcard/Download/speakeasy_crash_YYYY-MM-DDTHH-MM-SS.txt`
  (Termux-readable, no SAF needed).
- **On-device diagnostics screen.** Hidden support tool: tap the version
  line in **AboutScreen** 5 times in a row to unlock it (no visible
  Diagnostics row). Opens a full diag log with breadcrumbs from the
  message router, ChatScreen send path, group create. Selectable text
  for paste-back debug. Lives in `apps/mobile/src/diag/log.ts` +
  `screens/DiagnosticsScreen.tsx`.
- **Server.** Fastify on port 8080. In-memory repos by default
  (no `DATABASE_URL`); `DrizzleUserRepo` available when configured.
  WS handler at `apps/api/src/ws/handler.ts`. Currently runs on the
  Linux box at `65.21.224.209:8080` with `VOUCHFLOW_USE_MOCK=1`.
- **Tier A integration tests.** 97 mobile + 108 api + smaller package
  suites — total **234 tests**. Vitest, Node. Two-client harness in
  `apps/mobile/src/integration/harness.ts` drives the actual mobile JS
  modules against an in-memory Fastify.
- **Tier B emulator E2E.** 5 Maestro flows
  (`apps/mobile/maestro/0[1-5]-*.yaml`) running on a Pixel 5 emulator
  in CI. Gates `main` and `alpha-*` tags.
- **Release CI.** `release.yml` on tag push — builds release APK with
  `VOUCHFLOW_WRITE_KEY` secret, uploads to GitHub release.
- **Build-time guards.** `app/build.gradle` fails if `vouchflow.apiKey`
  is the placeholder. Gradle prebuild hook always runs `npm run build`
  for `@speakeasy/{shared,crypto,vouchflow}` so workspace package edits
  can never silently miss a re-bundle.
- **Hermes-banned-globals lint.** `apps/mobile/src/integration/no-hermes-banned-globals.test.ts`
  scans `apps/mobile/src`, `packages/crypto/src`, `packages/shared/src`
  for `Buffer.method` / `new Buffer(` / `new TextDecoder` / `new TextEncoder`
  and fails CI if any non-`utils/bytes.ts` file uses them. Hermes
  doesn't ship those — every byte/string/base64 conversion goes
  through `apps/mobile/src/utils/bytes.ts` (mirror in
  `packages/crypto/src/bytes.ts`).

### What's broken / unfinished

- **iOS native shells** are authored at `apps/mobile/ios/SpeakeasyBridges/`
  but compile-verification is gated on Mac access (see §Mac access).
  Same JS interfaces as Android, same wire formats. **No Tier B coverage
  for iOS yet** — the workflow only boots an Android emulator. iOS Tier
  B would need either a self-hosted Mac runner or `actions/macos-13`
  with Xcode + an iOS simulator, both significantly slower and more
  expensive.
- **Real Vouchflow integration in alpha** is currently mocked. Sandbox
  server has `VOUCHFLOW_USE_MOCK=1` set (uses `LocalDevValidator` —
  stateful in-memory) because sideloaded debug-signed APKs fail Play
  Integrity, which makes real Vouchflow record `total_verifications: 0`
  and the validator throws `no_verification`. Memory file at
  `~/.claude/projects/-home-lunchbox/memory/vouchflow_alpha_attestation_workaround.md`
  has full context. Resolution path: Vouchflow Android SDK update that
  records `confidence: low` verify even when Play Integrity is
  degraded; once shipped, drop `VOUCHFLOW_USE_MOCK=1` from the sandbox
  env. Spec §11 Phase 5b carry-over.
- **SQLCipher conversation persistence** still uses AsyncStorage stub.
  The Signal Protocol store IS SQLCipher-backed (Phase 5c — landed),
  but the conversations / messages store is plain AsyncStorage from the
  fix in 0.2.10. Real SQLCipher migration is queued under §4c. Watch
  out: SQLCipher Android's `rawQuery(String, Object...)` overload
  mis-binds `Int` args — coerce to `String[]` (this bit me three
  times; one open commit, see git log for "rawQuery int-arg bug").
- **Push notifications** are stubbed (`NoopPushProvider` in dev,
  `MockPushProvider` in tests). FCM integration is Phase 5d.
- **Sealed sender** (hide message sender from server) deferred — spec §13.
- **Drizzle implementations** of all repos beyond `DrizzleUserRepo` are
  missing — `PreKeyRepo`, `GroupRepo`, `CommunityRepo`, `MessagesRepo`,
  `DevicesRepo` all use `InMemory*` impls in production paths when
  `DATABASE_URL` isn't set. Phase 5 work.
- **Multi-device pairing UX** not built (secondary device discovery +
  envelope re-distribution). Spec §4b.
- **iOS Tier B coverage** — see iOS bullet above.
- **Recovery / re-enrollment UX.** No "I lost my device" flow. Identity
  is per-install; uninstall = lose your conversations.

### Recent surfaced bugs (lessons)

These are the bugs Tier B caught in its first 14 iterations. Pattern is
worth internalising:

1. Hermes runtime is **missing** Web/Node APIs that RN docs claim it ships
   — at minimum `Buffer`, `TextDecoder`, `TextEncoder`. Lint enforces.
2. SQLCipher `rawQuery` mis-binds `Int` args silently — appears as
   "session not found" in libsignal calls because lookup misses the
   row that storeSession just wrote. Always use `String[]` for
   selection args.
3. React Navigation `Stack.Navigator` selects the FIRST registered
   screen as default. Order matters — initial route was wrong post-
   relaunch (showed IdReveal instead of Conversations).
4. Maestro on GHA emulator hits "Pixel Launcher isn't responding" ANR
   on cold boot — flows need `runFlow.when.visible: "Wait" → tapOn:
   "Wait"` to dismiss. App is fine underneath.
5. `react-native-screens` modal back behaviour — Android system back
   doesn't reliably consume on `presentation: 'modal'` routes. Tap
   in-app back button via `testID` instead.
6. `actions/upload-artifact@v4` glob `/tmp/maestro-*/**` returns 0
   files. Use the `/tmp/maestro-staging/` flat-dir copy pattern.
7. Workspace package source edits (`packages/shared/src/...`) need
   `npm run build` before the mobile bundle picks them up. Gradle
   prebuild hook handles it now; if you add a new package, add it to
   the hook in `apps/mobile/android/app/build.gradle`.

## Repository layout

Turborepo monorepo with npm workspaces. Quick map:

```
apps/
  api/            Fastify server (Vouchflow auth, WS, Drizzle ORM, ioredis)
  mobile/         React Native (RN 0.76.5, Hermes, new arch)
    android/      Android shell — xyz.speakeasyapp.app
    ios/          iOS shell — same package id
    src/
      screens/    Onboarding, IdReveal, Conversations, Chat, GroupChat, NewChat, NewGroup, Diagnostics
      ws/         message-router.ts, client.ts
      crypto/     session.ts, group-orchestration.ts, replenish.ts
      store/      identity.ts (persisted), conversations.ts (persisted), groups.ts, distribution-ids.ts, connection.ts
      api/        client.ts (REST)
      utils/      bytes.ts (Hermes-safe byte/string/b64 helpers)
      diag/       log.ts (in-process diagnostic ring buffer)
      integration/ harness.ts + Tier A integration tests
      __mocks__/  AsyncStorage in-memory stub for vitest
    maestro/      Tier B flow YAMLs
    scripts/      write-test-config.mjs (CI uses to repoint to 10.0.2.2)
    assets/       logo-mark.png (brand asset)
packages/
  shared/         Wire types + word lists + ID generation
  crypto/         Signal Protocol + Channel Key + Group Messaging contracts
                  (bytes.ts mirrors apps/mobile/src/utils/bytes.ts)
  vouchflow/      Server-side Vouchflow validator + REST client
infra/
  migrations/     Postgres migrations
  fly/            Fly.io deploy config (not yet deployed)
spec.md           Authoritative spec — keep updated as work lands
CLAUDE.md         Persistent project notes (Mac SSH details, dev quirks)
HANDOFF.md        This file
```

## Mac access (for iOS work)

The Mac is reachable via Tailscale from the Linux dev box. SSH key is
already installed; just connect:

```sh
ssh dani@macbook-pro-7
```

Full details in **`CLAUDE.md`** under "Mac SSH access" — that's the
authoritative source. Highlights:

- Mac hostname: `macbook-pro-7` (Tailscale IP `100.104.88.126`)
- macOS 26.4.1, Xcode 26.4.1, Intel x86_64
- Username `dani`, home `/Users/dani`
- iOS toolchain installed: Homebrew, Node 25.9, CocoaPods 1.16, cmake,
  Xcode + iOS device & Simulator platforms downloaded
- libsignal-client-ios is wired via CocoaPods (not SPM); see CLAUDE.md
  for the exact recipe
- The repo is **not yet cloned on the Mac** — first iOS sync needs
  either `rsync -avz --exclude node_modules --exclude .git/objects/pack`
  from this Linux box, or `git clone` directly on the Mac
- Connection is DERP-relayed (~240–530ms RTT) — slow but reliable;
  bandwidth-bound

When you do iOS work:
1. `ssh dani@macbook-pro-7`
2. `cd ~/speakeasy/apps/mobile/ios`
3. `pod install` (one-time after dependency changes)
4. `xcodebuild -workspace Speakeasy.xcworkspace -scheme Speakeasy -sdk iphonesimulator build`
5. For tests: `xcodebuild test ...`

## Sandbox server

Running on this Linux box at `65.21.224.209:8080`. Mobile app config in
`apps/mobile/src/config.ts` points there.

```sh
# Health check
curl http://65.21.224.209:8080/healthz   # → {"ok":true}

# Logs
tail -f /tmp/speakeasy-api.log

# Restart
pkill -f 'node dist/server.js'
cd /home/lunchbox/speakeasy/apps/api
set -a && . .env.local && set +a
PORT=8080 HOST=0.0.0.0 LOG_LEVEL=info VOUCHFLOW_USE_MOCK=1 \
  nohup node dist/server.js > /tmp/speakeasy-api.log 2>&1 & disown
```

`.env.local` has the real Vouchflow read/write keys. **Don't commit it.**
The `VOUCHFLOW_WRITE_KEY` is also set as a GitHub repo secret for CI:

```sh
gh secret list -R Speakeasy-Messenger/speakeasy
```

## Test pyramid

### Tier A — vitest, Node, ~234 tests
- `apps/api/src/**/*.test.ts` — server-side, 108 tests
- `apps/mobile/src/**/*.test.ts` — mobile-side, 97 tests
- `packages/{shared,crypto,vouchflow}/src/**/*.test.ts` — ~30 tests

Run from any package directory:
```sh
npm test                # via turbo from root
npx vitest run          # from individual package
```

The harness in `apps/mobile/src/integration/harness.ts` is your friend
for two-client integration tests — drives the actual mobile JS modules
(message router, conversations store, ws/api clients) against an
in-process Fastify. Read `harness.ts` + `reported-bugs.test.ts` for
patterns.

### Tier B — Maestro on Android emulator in CI
- 5 flows in `apps/mobile/maestro/`:
  1. `01-enroll.yaml` — first-run enrollment
  2. `02-self-dm.yaml` — self-DM round-trip + back-nav
  3. `03-background-foreground.yaml` — identity + history persistence
  4. `04-peer-not-found.yaml` — chat-open precheck inline error
  5. `05-group-create.yaml` — NewGroup → GroupChat
- Workflow: `.github/workflows/tier-b-emulator.yml`
- Triggers on push to `main` AND on `alpha-*` tags
- Runs on `ubuntu-latest` with KVM-accelerated Pixel 5 emulator
- ~12-15 min cold per run; ~7 min warm
- Adds testIDs to screen elements as needed; current testID inventory
  in the screens themselves (search for `testID="`)

When adding a new flow:
1. Add testIDs to UI elements you'll target
2. Write the flow YAML — start with `runFlow.when.visible: "Wait"` to
   dismiss the GHA emulator's launcher ANR
3. Use `extendedWaitUntil` (not `assertVisible`) for anything that
   takes time
4. Use `pasteText` to paste the most-recent `copyTextFrom` value
5. Add the flow path to the `script:` chain in
   `.github/workflows/tier-b-emulator.yml`
6. Push, watch CI, iterate. Failure screenshots land in the
   `maestro-debug-<sha>` artifact — download with
   `gh run download <run-id> --dir /tmp/x` and read the PNGs

## Release process

1. Work on `staging`, open a PR to `main`
2. CI runs Tier A (`ci.yml`) on every push to PR
3. Human reviews, merges to `main`
4. Tier B (`tier-b-emulator.yml`) fires on the merge — that's the gate
5. Human tags: `git tag alpha-X.Y.Z && git push --tags`
6. `release.yml` fires on the tag, builds release APK with
   `VOUCHFLOW_WRITE_KEY` secret, uploads as a release asset

Don't tag yourself. Tagging is the human's gesture of "ship it" — your
job is to make the green-Tier-B + green-Tier-A state available so they
can.

## Phases ahead (per spec §11)

The implementation status table at the top of `spec.md` is the
authoritative tracker. As of 2026-05-01, summary:

- Phase 0–4: ✅ done
- **Phase 5a** (RN shells): ✅ Android + iOS shells generated
- **Phase 5b** (native bridges): ✅ all 4 Android bridges; iOS bridges
  authored, compile-pending Mac access
- **Phase 5b carry-over** (PreKey replenishment, real device runtime
  testing for iOS): partially done; iOS device runtime testing pending
- **Phase 5c** (SQLCipher local persistence): ✅ Signal store backed;
  conversations store still on AsyncStorage
- **Phase 5d** (push notifications, real FCM): ⏳ not started
- **Phase 5e** (chat UX polish + group chat screens): ✅ basic chat
  + groups working; lots of polish opportunity
- **Phase 5f** (per-device delivery tracking): ✅ landed
- **Beyond Phase 5**: real Vouchflow integration in alpha (currently
  mocked), Drizzle impls of remaining repos, Fly deploy + DNS, sealed
  sender, multi-device pairing UX

**Next task you should pick up unless directed otherwise:** Phase 5d
push notifications. The `PushProvider` interface
(`apps/api/src/push/push.ts`) is wired through the WS handler; replace
`NoopPushProvider` with an FCM-backed impl. Tier B flow #6 should cover
"recipient is offline → sender's send produces a server-side push that
wakes the recipient". You'll need an Android FCM project + service-account
credentials (probably a GitHub secret).

## Workflow tips

- **Always read `spec.md` first** before starting a phase. The spec
  defines wire formats, security posture, error codes — diverging from
  it produces bugs that look like product issues but are spec
  violations.
- **Spawn subagents for exploration.** Use the Agent tool with
  `subagent_type: Explore` for "where in the codebase does X happen"
  and `subagent_type: general-purpose` for focused implementation
  chunks. Conserve your context for synthesis and decisions.
- **Don't chase Tier B failures by guessing.** Always download the
  artifact, look at the screenshot, read `maestro.log`. The screenshot
  tells you what state the app is actually in — you can't fix what you
  can't see.
- **`.github/workflows/release.yml` is the only thing that ships
  APKs.** Don't `gh release create` from local. The CI build is signed
  with the secret; local builds aren't.
- **Memory directory is at
  `~/.claude/projects/-home-lunchbox/memory/`.** I left one memory
  file there about Vouchflow alpha attestation. Add your own as you
  learn things future sessions will need.
- **The user is a fast technical reader**, keep status updates terse.
  Lead with state changes, not narration.

## Last word

Tier B took 14 iterations to go green. Most of those weren't product
bugs; they were CI scaffolding (line continuations, Maestro YAML
syntax, ANR handling, artifact globs). The product bugs Tier B caught
were **real** and would have shipped to alpha testers a third time
without it. Don't let Tier B atrophy. Add a flow whenever you ship a
behaviour that touches the screen-set.

The user has been generous about turnaround time but has zero patience
for false-positive test passes. If a test passes locally but a feature
breaks on device, that's a test gap — write the test that would have
caught it, then fix the bug.

Good luck.
