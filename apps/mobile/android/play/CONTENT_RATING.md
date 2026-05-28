# Content rating — IARC questionnaire

Play Console → App content → Content ratings → Start questionnaire.

The questionnaire feeds the International Age Rating Coalition (IARC)
which auto-assigns regional ratings (ESRB, PEGI, USK, ClassInd, etc.)
in a single pass. For a messenger app with user-generated content
but no native risky content, expect a **Teen** or equivalent rating
across most markets, with the user-to-user interaction flag.

This doc gives the conservative-honest answer set for Speakeasy.

---

## Category selection (first question)

**Communication**

(Not Game, not Reference, not Social — the Social category implies
public-facing content streams which Speakeasy doesn't have.)

---

## Questionnaire answers

### Violence

- Does the app contain violence? **No** (no in-app violent content).
- Does the app contain depictions of violence between fantasy characters? **No**
- Does the app contain depictions of violence with realistic-looking humans or animals? **No**

User-generated note: users CAN send each other messages with any
content. The content-rating questionnaire is about what the **app
itself** contains, not what users might exchange privately. Don't
flag here.

### Sexuality

- Does the app contain references to sexual activity? **No**
- Does the app contain depictions of sexual activity? **No**
- Does the app contain nudity? **No**
- Does the app contain depictions of erotica or pornography? **No**

### Language

- Does the app contain profanity? **No**
- Does the app contain crude humor? **No**

### Controlled substances

- Does the app contain references to or depictions of drugs, alcohol, or tobacco? **No**

### Crime

- Does the app contain depictions of criminal activity? **No**
- Does the app glorify or encourage criminal activity? **No**

### Gambling

- Does the app contain simulated gambling? **No**
- Does the app contain real-money gambling? **No**

### Horror and fear

- Does the app contain content intended to scare or frighten? **No**

### Discrimination

- Does the app contain content that promotes discrimination? **No**

### Interactivity

This is the section that matters for a messenger:

- **Users can interact with each other**: **Yes**
  - Speakeasy is built for 1:1 and group messaging.
- **Users can exchange content (text, images, files)**: **Yes**
- **Users can share their location**: **No** (location sharing is
  not a feature.)
- **Users can make in-app purchases**: **No** (alpha is free; future
  subscriptions are out of scope until paid tier ships.)
- **The app contains digital purchases**: **No**
- **The app shares user-provided info with third parties**: **No**
- **Users can communicate with strangers**: **Yes** (technically —
  anyone with your handle can send you a contact request. Recipients
  decide whether to accept. Honest answer.)
- **The app accesses, collects, or shares the user's precise location**: **No**

### Final classification expectations

With "Users can interact" + "Users can exchange content" + "Users
can communicate with strangers" flagged, expect:

- **ESRB**: Teen
- **PEGI**: 12
- **USK**: 12
- **ClassInd (Brazil)**: 10
- **Generic IARC**: Teen / 12+

These ratings are about the interaction surface, not the app's
content. They're appropriate.

---

## "Target audience and content" section (separate from content rating)

After the rating questionnaire, Play Console asks about target
audience:

- **Target age groups**: 13+ (matches IARC Teen and respects
  COPPA — we don't want under-13 users we have no consent flow for).
- **Appeals to children**: **No** — Speakeasy is not designed for or
  marketed to children.
- **Includes ads**: **No**.
- **App access**: All functionality available without restricted
  parts. (We don't have a Premium-locked feature gate to declare.)

---

## App access for review

Google's reviewers test the app. Provide test credentials so they
can see the messaging flow.

- **Username/Handle**: Provide a pre-enrolled test handle (e.g.
  `@reviewer_speakeasy` — sign up once, save the handle and a backup
  of the keystore).
- **Password**: N/A — Speakeasy uses device attestation (Vouchflow),
  not passwords. Note this in the "Notes" field of the App access
  form: "Speakeasy uses passwordless biometric attestation via
  Vouchflow. To test, install the APK and sign up with the
  reviewer handle — biometric prompt on the reviewer's device
  device-binds the install."
- **Other instructions**: Mention that some features require a peer
  to interact with. Provide a second test handle if Google's
  reviewer flow is single-tester.
