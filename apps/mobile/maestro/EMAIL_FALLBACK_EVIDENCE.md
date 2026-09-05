# Email-fallback onboarding: what is proven, and what is not

Evidence for the Vouchflow email-OTP fallback added in #206 (App Store
rejection 2.1(a) — "This one's mine" dead-ended on the reviewer's iPad).

Read this before resubmitting. The unit tests in
`src/auth/claim-handle.test.ts` mock `requestFallback` as always
succeeding and `getCachedDeviceToken` as always `null`, so a green suite
says nothing about either of the two things that actually decide whether
a reviewer gets through.

## The chain, and where each link stands

| # | Link | Status |
|---|------|--------|
| 1 | Un-attestable device is offered the fallback instead of dead-ending | **OBSERVED** — run 1, waypoint A |
| 2 | `requestFallback` returns a session id | **OBSERVED** — run 1, waypoint B |
| 3 | Vouchflow emails a 6-digit code | **OBSERVED** — run 1, delivered in ~1s |
| 4 | `submitFallbackOtp` → device token → `api.enroll` | **UNPROVEN** — run 1 stopped here by design |

Link 4 is the step #206 inferred from the SDK surface rather than
documented behaviour, and it is the only one left. Run 1 was deliberately
`FALLBACK_OTP=SKIP`, so it stopped at the code screen; the runtime OTP
fetch added in PR #210 is what carries a run through it.

## Link 3: delivery works

**Settled by run 1.** The device asked for a code at 16:06:04 and Resend
delivered `Your Speakeasy verification code: 740170` at 16:06:05 — about
a second, to `lunchboxfortwo@gmail.com`, the plain inbox that had
previously received nothing. The code screen rendered it back as "We sent
a code to lunchboxfortwo@gmail.com. Enter it to finish."

Two things changed between the failures below and that run:
vouchflow-server **v2.13.3** (2026-09-04) fixed `last_verification`
ignoring a `FALLBACK_COMPLETE` event, and the run used the app's own
shipped `VOUCHFLOW_WRITE_KEY` rather than a vaulted key. Which of those
mattered is not established, and no longer needs to be.

### Superseded: the earlier delivery failures

Kept because it explains why this document exists, and what to look at if
delivery regresses. **Every row predates v2.13.3 and none of it reflects
current behaviour.**

`POST /v1/verify/{session}/fallback` returns `200` with
`{"method": "email_otp", ...}` and a five-minute expiry, and no mail
arrives. Five attempts, two independent inboxes, both API keys:

| # | Key | Inbox | Result |
|---|-----|-------|--------|
| 1 | sandbox (public, from the SDK repo) | `lunchboxfortwo+vfotp1@gmail.com` | no mail |
| 2 | production (vaulted `vouchflow/prod-write`) | `lunchboxfortwo+vfotp2@gmail.com` | no mail |
| 3 | production | `lunchboxfortwo@gmail.com` (no plus tag) | no mail |
| 4 | production | `sxfbmtn39p6g@uberip.com` (mail.tm, no filtering) | no mail |
| 5 | sandbox | `sxfbmtn3iyac@uberip.com` | no mail |

The Gmail searches used `in:anywhere`, so spam was covered, and the same
inbox received unrelated mail throughout the window. Submitting a guessed
code returns `422 invalid_otp` with `attempts_remaining`, then
`423 fallback_locked` — so a code does exist server-side; it just never
reaches anyone.

A sixth attempt was refused with `429 … retry in 1 day`, on a device
enrolled seconds earlier under a different key. The initiation limiter is
therefore keyed to something wider than the device — plan on roughly
three initiations per source per day when re-testing, and expect a device
farm to have its own quota because it has its own address.

Reproduce with `scripts/vouchflow-fallback-probe.mjs`, which drives the
REST API exactly as the SDK does for an un-attestable device and stops
before OTP submission.

**What it would have meant:** a code entry screen no user could satisfy,
i.e. a different dead end rather than a working path. Run 1 rules that
out. A future regression is now cheap to catch — a run whose relay never
sees a code fails at an explicit assert, with a video, instead of
stopping quietly at waypoint B.

**Still worth a human's eye:** whether the app's shipped `VOUCHFLOW_WRITE_KEY`
belongs to the same Vouchflow account as the vaulted `prod-write` key
tested here, and whether that account has email delivery configured in
the vouchflow.dev dashboard (no dashboard credentials were available for
this run).

A second thing only a human with deploy access can confirm: a fallback
verification is always `confidence: low`, so if the deployed API sets
`VOUCHFLOW_MIN_CONFIDENCE=medium` the server rejects the token with
`low_confidence` even once link 3 works. This is independent of the
v2.13.3 fix — that changed whether the fallback is *recorded*, not the
floor it is measured against. `server.ts` defaults to
`MIN_CONFIDENCE` (`low`) and the env var is the only thing that raises
it; its value in production was not visible from here.

## The `no_session` dead ends

`Vouchflow.requestFallback` needs a live verification session:
`VerificationManager` sets `pendingFallbackSessionId` only after
`POST /v1/verify` succeeds, and `requestFallback` throws
`noActiveSession` without it (iOS SDK 2.4.0, the version pinned in
`Speakeasy.xcodeproj`; the Podfile comment saying 2.0.0 is stale).

`FALLBACK_ELIGIBLE` in `src/auth/claim-handle.ts` routes five SDK errors
to the fallback. Only one of them leaves a session behind:

- `biometric_unavailable` — thrown from `signChallenge`, i.e. **after**
  the session exists. This is the reviewer's iPad, and it works.
- `enrollment_failed`, `account_store_access_denied` — thrown during
  enrollment, before any session. `requestFallback` → `no_session`.
- `minimum_confidence_unmet` — thrown wherever the API client sees
  `verification_impossible`; from session initiation there is no session.
- `attestation_unavailable` — the iOS SDK never throws it.

The no-lock branch returns `needs_email_fallback` without calling
`verify()` at all, so it can only produce `no_session`. On iOS that
branch is unreachable — `isDeviceSecure()` in `src/native/lock-screen.ts`
returns `true` on any non-Android platform — but on Android it is exactly
what a lockless device hits.

Conversely `biometric_failed` and `biometric_cancelled`, the two cases
the SDK documents as the fallback triggers and which always leave a live
session, are deliberately excluded from `FALLBACK_ELIGIBLE`.

## Device run

### Run 1 — 2026-09-05 16:05 UTC, waypoints A and B observed

BrowserStack iPhone 15 / iOS 26.6, signed IPA, `FALLBACK_OTP=SKIP`.
Build `1b1385ca9deacdf9c178671ee4894582affeffbb` —
[video and logs](https://app-automate.browserstack.com/builds/1b1385ca9deacdf9c178671ee4894582affeffbb).

| Time | What |
|------|------|
| 16:05:49 | `LAContext` found no device-owner auth → `verify()` failed fallback-eligibly. The farm-wipe premise holds on an iPhone. |
| 16:05:49 | Vouchflow verification `36eb47a3…` created: state `FALLBACK`, context `signup`, `fallbackUsed=true`. |
| 16:05:50 | **Waypoint A** — `onboarding-fallback-email` visible. |
| 16:06:04 | "Email me a code" → one request → `200` in 245 ms. |
| 16:06:05 | Resend `4571eacd…` "Your Speakeasy verification code: 740170" delivered. |
| 16:06:06 | **Waypoint B** — `onboarding-fallback-otp` visible, code screen rendered. |
| 16:06:24 | Flow failed on a harness bug (below), not on app behaviour. |

So links 1, 2 and 3 are observed, and the `biometric_unavailable` branch
described under "The `no_session` dead ends" is now a captured run rather
than source reading. Link 4 was not exercised: run 1 was `SKIP`.

Two harness bugs it exposed, both fixed:

- **`assertVisible: 'We sent a code to'` failed while the code screen was
  correctly on display.** Maestro text matchers are regexes that must
  match an element's FULL text, and the element read "We sent a code to
  lunchboxfortwo@gmail.com. Enter it to finish." Now `'We sent a code
  to.*'`. Worth remembering for any assert added later: a prefix is not
  enough.
- **The handle drifted.** `fallbackqa15870` was typed and confirmed
  available at waypoint A, but the code screen showed an auto-picked
  `sable-high-pier` — "Generate one for me" sits in the same button stack,
  and `KeyboardAvoidingView` reflows the screen when the keyboard goes, so
  a tap resolved before the reflow can land on it. This matters because
  the handle in that field at verify time is the one actually claimed. The
  flow now settles after `hideKeyboard` and asserts the handle both after
  typing it and at waypoint B.

### Run 2 — first with the relay armed

Two bugs in the new runtime-OTP path, both found only once a run actually
carried a code, both fixed:

- **Resend answered `403` to the relay.** It rejects urllib's default
  `Python-urllib/3.x` User-Agent; the same key and URL return `200` under
  curl. The relay now sends `speakeasy-otp-relay/1`. This one was worth
  the trouble it caused: a 403 is indistinguishable from "no mail yet"
  inside the poll loop, so the symptom was a silent four-minute wait and
  an assert blaming Vouchflow delivery for an HTTP client detail.
- **The tunnel probe was too eager.** A just-created
  `trycloudflare.com` hostname takes a few seconds to resolve, and the
  runner probed it once, immediately, then exited "not reachable" before
  uploading anything. Now a bounded retry (18 x 5s).
- **The sub-flow never polled at all.** `_email-fallback-otp.yaml`
  declared its own `env: OTP_URL: ''`, and that declaration shadowed the
  value the parent flow had: a sub-flow does not inherit the caller's
  variables. So `OTP_URL` was always empty inside it, the poll loop's
  `OTP_URL !== ''` guard was never true, the whole `repeat` was skipped,
  and the run failed at `assertTrue output.otp !== ''` — reporting "no
  code arrived" while the relay held a perfectly good code. The parent now
  passes both values through `runFlow: env:`, and the sub-flow declares no
  defaults at all, so there is nothing left to shadow regardless of which
  way that precedence runs.

### Earlier attempts

The two BrowserStack rejections before run 1, both harness bugs:

- **`POST /maestro/v2/build` → HTML 404.** The Maestro build *trigger* is
  platform-scoped; the correct path is `/maestro/v2/ios/build`
  (`/android/build` for Android). Uploads (`/app-automate/upload`,
  `/maestro/v2/test-suite`) and the `/maestro/v2/builds/{id}` poll are
  **not** scoped and were correct as written.
- **`422 BROWSERSTACK_APP_BUILT_FOR_IPHONE` on every iPad.** The app is
  built iPhone-only (`UIDeviceFamily`), so BrowserStack will not install
  it on an iPad. The default device is now an iPhone.

  This costs nothing in evidence. The un-attestable condition this proof
  depends on comes from the farm wiping the device between sessions — no
  passcode, no enrolled biometric — not from the form factor, and farm
  iPhones are wiped the same way. The App Store reviewer used an iPad, but
  reproducing that exact hardware would first require the app to declare
  iPad support, which is a product decision and not one this harness
  should force.

Both failures were slower to read than they should have been: the 404 was
an HTML body fed straight into a JSON parser, which reports a decode error
at column 1 rather than "404". The runner now prints the raw response
before parsing it, and names the HTTP status when a reply is not the JSON
it expected.

- Simulator (`ios-fallback-e2e.yml`): first attempt failed booting, on a
  device-type/runtime pairing bug since fixed; second failed in the
  simulator build step, and its log could not be retrieved. The workflow
  needs one more debugging pass.

## Running it again

```sh
# 1. Build: the "BrowserStack iOS email-fallback harness" workflow.
#    It uses fastlane's build_beta lane, i.e. the ordinary App Store
#    binary — the browserstack lane's SPEAKEASY_VIDEO_CALL_HARNESS build
#    flag skips onboarding entirely.
# 2. Run — one unattended pass, all three waypoints:
IPA=Speakeasy.ipa SUITE=speakeasy-ios-fallback.zip \
FALLBACK_EMAIL=<the inbox Vouchflow should mail> \
RESEND_API_KEY=re_... \
  ./scripts/browserstack-ios-fallback.sh
```

The script prints the build id, the BrowserStack video/log URL and a
PASS/FAIL verdict, and exits non-zero on FAIL.

Vouchflow has no deterministic test OTP: the code is minted only once the
device reaches the code screen and expires five minutes later, so it
cannot be patched into the flow before upload. With `RESEND_API_KEY` set,
`scripts/otp-relay.py` watches the inbox through Vouchflow's sender and
serves the code behind a throwaway `cloudflared` tunnel; the flow fetches
it from the device mid-run. Nothing is persisted — the tunnel carries one
single-use code for one build and dies with the script.

Two other ways to run it, both still supported:

- `FALLBACK_OTP=123456` — a code read out of the inbox by hand. Use this
  to re-drive waypoint C without a Resend key.
- Neither variable — proves waypoints A and B only and stops at the code
  screen. This is what the harness could do before, and it is now the
  fallback rather than the ceiling.

Budget the rate limit: initiation is capped near three per source per day
(above), so an unattended run is worth spending on a build you expect to
reach waypoint B.
