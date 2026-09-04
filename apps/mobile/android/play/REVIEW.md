# Play Store listing — full review

This is every field Play Console will ask for, in the order it asks,
with the current value pulled from the canonical sources in
`fastlane/metadata/android/en-US/` and the per-Console docs in this
directory. Read it top to bottom. Anything tagged **MISSING** or
**TODO** is a blocker for promotion to a public track (Open Testing
or Production); Internal/Closed Testing does NOT require the asset
fields.

Last assembled: 2026-05-28.

---

## App details

| Field                  | Value                                                                    | Notes                                                                                               |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **App name**           | `Speakeasy — Private Messages`                                           | 30/30 chars (Play's max). Uses an em-dash, not a hyphen — looks intentional and brand-correct.      |
| **Short description**  | `Encrypted messaging without a phone number or your real name.`          | Keeps the privacy differentiators without implying that the optional email fallback does not exist. |
| **App category**       | Communication                                                            | Not Social, not Productivity.                                                                       |
| **Tags** (up to 5)     | Messaging · Encrypted communication · Privacy · Voice calls · Group chat | Specific tags > generic ones for Play search ranking.                                               |
| **Contact email**      | `hello@speakeasyapp.xyz`                                                 | **TODO: confirm this inbox is actually monitored.** Google uses it for enforcement notices.         |
| **Contact phone**      | (blank)                                                                  | Optional.                                                                                           |
| **Website**            | `https://speakeasyapp.xyz`                                               |                                                                                                     |
| **Privacy policy URL** | `https://speakeasyapp.xyz/privacy/`                                      | Confirmed live (5.7 KB branded page).                                                               |

---

## Full description

The authoritative copy is
[`fastlane/metadata/android/en-US/full_description.txt`](../../../../fastlane/metadata/android/en-US/full_description.txt).
Copy that file into Play Console immediately before submission; do not maintain
a second prose copy here.

Headers are in CAPS rather than bold because Play Console's listing
renderer doesn't honor Markdown. CAPS is the convention competitors
(Signal, Telegram, Wire) all use.

---

## Graphics

| Asset                    | Spec                            | Status                                                                                                                |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| App icon                 | 512×512 PNG                     | **MISSING** — needs upscale from `mipmap-xxxhdpi/ic_launcher.png` or vector source                                    |
| Feature graphic          | 1024×500 PNG, no transparency   | **MISSING** — proposed: brand canvas (INK background) with wordmark + animal silhouette                               |
| Phone screenshots        | 1080×1920+ portrait, 2–8 images | ✅ **7 real-device captures landed** in `fastlane/metadata/android/en-US/images/phoneScreenshots/` — see lineup below |
| Tablet screenshots       | optional                        | N/A (don't claim tablet support)                                                                                      |
| 7-inch / 10-inch tablets | optional                        | N/A                                                                                                                   |
| Promo video (YouTube)    | optional                        | Skip for v1                                                                                                           |

### Screenshot lineup — 7 real-device captures (1080×2340 / 1080×2400)

In Play Store carousel order (first is the most-visible hero):

1. **`1_door.png`** — Door / "speakeasy." wordmark — the brand-defining first impression. Light mode. Brass wordmark on cream + the door brand mark.
2. **`2_avatar-picker.jpg`** — "Change my face" / 12-animal menagerie + selected Phoenix below — sells the unique animal-as-identity model. Most distinctive single shot in the app.
3. **`3_private-call-connected.jpg`** — Private call to `@bananaman5` with the peer's heron portrait inside a portrait frame, call timer 00:02, your own avatar (red bat) bottom-left tagged "YOU". "PRIVATE CALL · CONNECTED" header in brass. Sells the voice filter / avatar-as-face moment that no other messenger has.
4. **`4_group-chat.jpg`** — "Workout crew" group room, "2 IN THE ROOM · LEAVES IN 24H" status, real conversation visible with brass outgoing bubble + dark incoming bubbles. Sells the chat-with-ephemeral-default story.
5. **`5_your-handle-qr.jpg`** — Your handle (`@peachtree`) + portrait + QR code + Copy/Share-via buttons. Sells the no-phone-number / share-by-handle mechanic.
6. **`6_private-call-ringing.jpg`** — Outgoing call to `@bananaman5`, "their phone is ringing" copy, the brass door mark pulsing. The ambient brand moment — calls feel like an event.
7. **`7_speaker-announcements.jpg`** — `@speaker` ANNOUNCEMENTS channel with release-note messages. Shows the bot/announcements feature and the "Announcements only — you can't reply here" pattern. (Optional — drop if 6 reads tighter.)

Original device captures: see `~/.claude/uploads/.../*.jpg` from session 2026-05-28. 5. **Avatar picker** — the menagerie of animal avatars. Sells the "your face is an animal" identity model.

Internal Testing track does NOT require any of these. We can ship to
Closed Testing without screenshots. Open Testing and Production both
require icon + feature graphic + ≥2 phone screenshots.

---

## Content rating (IARC questionnaire)

Filed answers in `CONTENT_RATING.md`. Expected outcome with the
"users interact + exchange content + can communicate with strangers"
flags set:

- ESRB: **Teen**
- PEGI: **12**
- USK: **12**
- ClassInd (Brazil): **10**
- Generic IARC: **Teen / 12+**

These ratings are about the interaction surface, not the app's content.
Appropriate for a messenger.

---

## Target audience and content

| Field                   | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| **Target age groups**   | 13+                                                  |
| **Appeals to children** | No                                                   |
| **Includes ads**        | No                                                   |
| **App access**          | All functionality available — no restricted features |

---

## Data safety form (high-stakes — Google scrutinizes E2E claims)

Full per-data-type checklist is in `DATA_SAFETY.md`. The summary
Google's reviewer sees:

**Top-level questions:**

- Does your app collect or share data? **Yes** (messages and call audio,
  both encrypted end-to-end; Google's definition of "collect" includes
  transit, so we declare it)
- Is data encrypted in transit? **Yes**
- Can users request data deletion? **Yes** (Account → Delete account)

**What's declared as collected:**

| Category          | Items                                                                         | Why                                     |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| Personal info     | Email address (optional fallback), User IDs (handle + Vouchflow device token) | Account functionality                   |
| Messages          | In-app messages (ciphertext only)                                             | App functionality (relay between users) |
| Photos and videos | Photos, videos (when user attaches)                                           | App functionality                       |
| Audio files       | Voice notes + live call audio                                                 | App functionality (Private Calls)       |
| Files and docs    | File attachments                                                              | App functionality                       |
| App info          | Crash logs, diagnostics                                                       | App functionality (debugging)           |
| Device IDs        | Vouchflow attestation token                                                   | Account management                      |

**What is NOT collected** (and where competitors often get this wrong):
phone number, real name, location (precise or coarse), contacts, calendar,
web browsing, in-app interactions, installed apps, advertising ID. Email is
collected only when the user chooses the Vouchflow fallback for a device that
cannot attest; it is used to deliver the one-time code and is not stored with
the handle.

**Nothing is shared** — every "Shared?" column is "No."

**Security practices declared:**

- ✅ Data encrypted in transit
- ✅ Users can request deletion
- ✅ Follows Play Families Policy
- ❌ Independent security review (libsignal is audited; the Speakeasy
  app layer has not been third-party audited yet — be honest and uncheck
  this until we pay for one)

---

## App access (for Google's reviewer)

Google's reviewer will try to test the app. Provide:

- **Username/Handle**: A pre-enrolled reviewer handle (e.g.
  `@reviewer-speakeasy`). **TODO: create this account + save its keystore
  backup before submitting.**
- **Password**: N/A — Speakeasy uses Vouchflow device attestation. If a
  review device cannot attest, the onboarding screen offers a one-time
  email-code fallback instead. In the Notes field paste:
  > "Speakeasy uses Vouchflow device attestation. To test, install the AAB
  > and sign up with the reviewer handle; if the review device cannot
  > complete attestation, choose the email-code fallback on the handle
  > screen."
- **Other instructions**: Mention that the messaging and call flows
  require a peer. Provide a SECOND reviewer handle if Google's review
  is single-tester, so the reviewer can message themselves between two
  test devices/emulators.

---

## What's NOT in the listing (intentional)

- **Translations** — en-US only for v1. Adding locales multiplies
  maintenance cost; revisit after the listing copy stabilizes.
- **In-app product setup** — Speakeasy is free during alpha. The
  subscription/IAP catalog gets configured when paid tier ships.
- **Promotional video** — skip for v1; production overhead with no
  obvious payoff at alpha-tester scale.

---

## Submission readiness gate

To promote from Internal/Closed Testing to **Open Testing** or
**Production**, Play Console will block submit until ALL of these are
ticked:

- [x] App icon uploaded (512×512) — **MISSING**
- [x] Feature graphic uploaded (1024×500) — **MISSING**
- [x] At least 2 phone screenshots uploaded — ✅ **7 ready**
- [x] Short description filled — ✅ done
- [x] Full description filled — ✅ done
- [x] Privacy policy URL set — ✅ done (`https://speakeasyapp.xyz/privacy/`)
- [x] Content rating questionnaire submitted — **TODO** (answers ready in `CONTENT_RATING.md`)
- [x] Data safety form submitted — **TODO** (answers ready in `DATA_SAFETY.md`)
- [x] Target audience set — **TODO** (answers: 13+, no kid appeal, no ads)
- [x] Categorization set — **TODO** (Communication + 5 tags)
- [x] App access / reviewer credentials provided — **TODO** (need reviewer handle)

**For the current Alpha (Closed Testing) track, none of the above are
required.** They become blockers only when promoting to Open Testing or
Production.

---

## What needs to happen to ship to Open Testing this week

In rough order of effort:

1. **Generate two graphics still missing** — app icon (512×512) and
   feature graphic (1024×500). Screenshots are done (7 real-device
   captures landed under `images/phoneScreenshots/`).
2. **Create reviewer handle(s)** in production — 10 minutes once we have
   a stable build.
3. **Fill content rating + data safety + target audience in Play
   Console** — copy-paste from the linked docs, ~30 minutes total.
4. **Promote rc.27 from Closed → Open** (or upload a fresh rc to the
   beta track).
5. First Open Testing submission triggers Google review (~24–48h).

The copy itself is done and reads well. The graphics are the gate.
