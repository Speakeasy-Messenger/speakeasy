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
| 3 | Vouchflow emails a 6-digit code | **NOT WORKING** — see below |
| 4 | `submitFallbackOtp` → device token → `api.enroll` | **UNPROVEN** — blocked by 3 |

Link 4 is the step #206 inferred from the SDK surface rather than
documented behaviour, and it is the one that still needs a human to
confirm. It cannot be reached while link 3 is broken.

## Link 3: the OTP is never delivered

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

**Consequence:** the fallback offers a code entry screen that no user can
ever satisfy. A reviewer reaches a different dead end than before, not a
working path.

**For a human to check:** whether the app's shipped `VOUCHFLOW_WRITE_KEY`
belongs to the same Vouchflow account as the vaulted `prod-write` key
tested here, and whether that account has email delivery configured in
the vouchflow.dev dashboard (no dashboard credentials were available for
this run).

A second thing only a human with deploy access can confirm: a fallback
verification is always `confidence: low`, so if the deployed API sets
`VOUCHFLOW_MIN_CONFIDENCE=medium` the server rejects the token with
`low_confidence` even once link 3 works. `server.ts` defaults to
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

None. Neither a real device nor a simulator got as far as running the
flow, so waypoints A and B are unobserved and everything in "The
`no_session` dead ends" below is source reading, not a captured run.

- Real device: the signed IPA builds, but the BrowserStack account lives
  in Trusty Squire and its egress proxy forwards JSON only, so a 53MB
  multipart upload returns `415`. The IPA cannot be published to reach the
  farm another way — it embeds the production Vouchflow write key and this
  repo is public. Unblocked by putting `BROWSERSTACK_USER` /
  `BROWSERSTACK_KEY` in Actions secrets.
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
# 2. Run:
IPA=Speakeasy.ipa SUITE=speakeasy-ios-fallback.zip \
FALLBACK_EMAIL=<an inbox you can read> \
  ./scripts/browserstack-ios-fallback.sh
```

Vouchflow has no deterministic test OTP, so waypoint C is gated on a
supplied `FALLBACK_OTP` that is still inside its five-minute window.
Automating it end-to-end needs the flow to read the code itself — an
`evalScript` step against an inbox API would do it — but that is not
worth building until link 3 delivers a code at all.
