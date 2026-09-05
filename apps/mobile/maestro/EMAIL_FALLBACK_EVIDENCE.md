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
| 1 | Un-attestable device is offered the fallback instead of dead-ending | see "Device run" |
| 2 | `requestFallback` returns a session id | see "Device run" |
| 3 | Vouchflow emails a 6-digit code | **UNPROVEN** — last observed failing, before the 2026-09-04 server fix |
| 4 | `submitFallbackOtp` → device token → `api.enroll` | **UNPROVEN** — now reachable; the harness runs it |

Link 4 is the step #206 inferred from the SDK surface rather than
documented behaviour, and it is the one this evidence exists to settle.
It is no longer gated on a human: `browserstack-ios-fallback.sh` drives
links 3 and 4 together in one unattended run (see "Running it again").

## Link 3: delivery, and the 2026-09-04 server fix

**vouchflow-server v2.13.3 (2026-09-04) is live.** It fixed
`last_verification` ignoring a `FALLBACK_COMPLETE` event — the
server-side defect that would have rejected the device token in link 4
even once a code arrived. That removes the known blocker on link 4.

It does not, on its own, settle the delivery failure recorded below, and
nothing in this repo can: "no mail leaves" and "a completed fallback is
not scored" are different symptoms, and no attempt has been observed from
here since the release. **Read the table as the last known state, not as
the current one** — every row in it predates the fix.

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

**Consequence, if delivery is still failing:** the fallback offers a code
entry screen that no user can satisfy, and a reviewer reaches a different
dead end than before rather than a working path. That is the outcome a
run has to rule out, and it is now cheap to check — a run whose relay
never sees a code fails at an explicit assert, with a video, instead of
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

Still none end-to-end: no run has yet driven the app, so waypoints A and B
remain unobserved and everything in "The `no_session` dead ends" is source
reading rather than a captured run.

What has changed is that the harness now reaches BrowserStack. The first
real run got far enough to be rejected twice, and both rejections were
harness bugs rather than app or Vouchflow behaviour. Both are fixed:

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
