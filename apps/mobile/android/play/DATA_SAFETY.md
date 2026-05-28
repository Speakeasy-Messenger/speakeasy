# Data Safety form — Play Console answers

The Data Safety form lives in Play Console → App content → Data safety.
It cannot be uploaded via the API; you fill it through the web UI.
This doc is the canonical answer set so the form stays accurate as
the app evolves. When you submit, work top-to-bottom and copy the
values here. When something changes in the app's data handling, update
this file FIRST and re-sync the form.

The form is high-stakes for an E2E messaging app. Google scrutinizes
the encryption claims. Better to be conservative + accurate than
optimistic and wrong.

---

## Data collection and security

### Does your app collect or share any of the required user data types?

**Yes** — Speakeasy collects audio (for calls) and messages (for
relay between users). Both are end-to-end encrypted; the server
holds only ciphertext, but Google's definition of "collect" includes
"transmits off the device for any duration," so we declare it.

### Is all of the user data collected by your app encrypted in transit?

**Yes.** Every byte that leaves the device is encrypted:

- Messages and attachments: end-to-end via the Signal Protocol
  (Double Ratchet + X3DH). The server's TLS layer is an additional
  outer envelope.
- Call audio: end-to-end via WebRTC SRTP, peer-to-peer when possible,
  TURN-relayed encrypted when not.
- Account metadata (handle, prekey bundles, push tokens): TLS to our
  API. No application-layer encryption because these are public-by-
  definition or device-authentication artifacts.

### Do you provide a way for users to request that their data be deleted?

**Yes.** Account → Delete account in the app. Deletes:

- The handle (released back to the public pool)
- The user's prekey bundle on the server
- The user's encrypted message-relay buffer
- The push token registration
- The Vouchflow device attestation record

Messages already delivered to peer devices remain on those devices —
we do not have the cryptographic ability to reach into someone else's
phone and delete their copy of a conversation.

---

## Per-data-type declarations

Walk the form's data-type checklist. For each category, mark
"Collected" / "Shared" / "Not collected" per the table below.

### Personal info

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Name | NOT collected | — | Handle is not a real name. |
| Email address | NOT collected | — | No email at signup. |
| User IDs | **Collected** (required) | NOT shared | The handle (`@velvet-cardinal`) and the Vouchflow device token. Both are app-internal — neither links to real-world identity. **Why collected: account functionality.** Encrypted in transit. Required to use the app. |
| Address | NOT collected | — | |
| Phone number | NOT collected | — | Famously not asked. |
| Race and ethnicity | NOT collected | — | |
| Political or religious beliefs | NOT collected | — | |
| Sexual orientation | NOT collected | — | |
| Other info | NOT collected | — | |

### Financial info

All sub-types: **NOT collected**. Speakeasy is free during alpha.

### Health and fitness

All sub-types: **NOT collected**.

### Messages

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Emails | NOT collected | — | |
| SMS or MMS | NOT collected | — | |
| Other in-app messages | **Collected** (required) | NOT shared | Encrypted ciphertext only. The server cannot decrypt. **Why collected: app functionality (message relay between users).** Encrypted in transit AND at rest in the relay buffer. Cleared from the buffer once delivered. |

**Important Data Safety nuance**: Google treats "collected" loosely
— even messages your server can't read are "collected" if they touch
your infrastructure. Check the box. The encryption-in-transit and
"can't read user data" claims are made elsewhere in the form (and in
the privacy policy) — that's where the E2E story is told.

### Photos and videos

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Photos | **Collected** (optional) | NOT shared | When the user attaches a photo to a message. End-to-end encrypted before upload. The server stores only ciphertext blobs and cannot view them. **Why collected: app functionality.** |
| Videos | **Collected** (optional) | NOT shared | Same as photos. |

### Audio files

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Voice or sound recordings | **Collected** (optional) | NOT shared | When the user attaches a voice note. E2E encrypted, same as photos. **Why collected: app functionality.** |
| Music files | NOT collected | — | |
| Other audio | **Collected** (required for calls) | NOT shared | Live call audio. WebRTC peer-to-peer where possible, TURN-relayed otherwise. SRTP-encrypted end-to-end in both cases. **Why collected: app functionality (Private Calls).** |

### Files and docs

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Files and docs | **Collected** (optional) | NOT shared | When the user attaches a file. Same E2E treatment as photos. |

### Calendar

All sub-types: **NOT collected**.

### Contacts

All sub-types: **NOT collected**. Speakeasy does not access the device
contact list. Adding a contact is done by exchanging handles (QR code,
share sheet, manual entry) — we never ingest the phone's address book.

### App activity

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| App interactions | NOT collected | — | No telemetry on what screens you visit or what features you use. |
| In-app search history | NOT collected | — | |
| Installed apps | NOT collected | — | |
| Other user-generated content | **Already covered** under Messages / Photos / Files. | — | |
| Other actions | NOT collected | — | |

### Web browsing

All sub-types: **NOT collected**.

### App info and performance

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Crash logs | **Collected** (optional) | NOT shared | Diagnostic crashes when the app crashes — sent to our error reporting (no third-party crash analytics yet). Does NOT include message contents. **Why collected: app functionality (debugging crashes).** |
| Diagnostics | **Collected** (optional) | NOT shared | The in-app diagnostics buffer (Diagnostics screen) is local-only. Nothing is auto-sent; the user can choose to share it from the screen if they hit an issue. |
| Other app performance data | NOT collected | — | |

### Device or other IDs

| Sub-type | Collected? | Shared? | Notes |
|---|---|---|---|
| Device or other IDs | **Collected** (required) | NOT shared | The Vouchflow device attestation token — a per-install cryptographic identifier. Required so the server knows which device is connecting; without it, end-to-end encryption setup would have no anchor. **Why collected: account management (authentication).** Encrypted in transit. |

---

## Security practices

Tick everything that's true:

- [x] Data is encrypted in transit
- [x] You can request that data be deleted
- [x] Committed to follow the Play Families Policy
- [x] Independent security review (we should note: libsignal is
      audited; the Speakeasy app layer hasn't had a third-party audit
      yet. Be honest — uncheck "Independent security review" until we
      pay for one. The Play form allows "no" without consequence.)

---

## Privacy policy

URL: **https://speakeasyapp.xyz/privacy/** (confirmed live — 301
redirects from /privacy to /privacy/; Play's URL field follows
redirects, but submitting the canonical trailing-slash form avoids
any future issue if Play tightens URL validation).

---

## Things to call out in the form's "Additional information" field

- "Messages and call audio are end-to-end encrypted with the Signal
  Protocol. The server transmits only ciphertext and does not have the
  keys to decrypt user content."
- "No personal identifiers are collected: no phone number, no email,
  no real name. The user-chosen handle and the per-device attestation
  token are the only persistent IDs."
- "Contacts are not accessed. Users add peers by exchanging handles
  manually, not by ingesting the device address book."

If the form asks "Why is this data collected?", the right answer for
every required field is "App functionality" or "Account management."
Never "Analytics" or "Advertising or marketing" — neither applies to
Speakeasy and selecting them would be wrong.
