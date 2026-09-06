# App Store listing — App Store Connect answers

The listing _copy_ lives in `fastlane/metadata/en-US/` (name, subtitle,
description, keywords, promo text, URLs, release notes) and is pushed by
`fastlane ios listing` / `.github/workflows/listing-ios.yml` — the iOS analog
of the Android `play-listing` flow. Screenshots live in
`fastlane/screenshots/en-US/`.

This doc covers the parts `deliver` can't set — the one-time things you click
through in the App Store Connect web UI. Counterpart of
`apps/mobile/android/play/STORE_LISTING.md`.

> **TestFlight needs none of this.** Internal TestFlight testing works with
> zero listing content. Everything here is only required before submitting to
> the App Store for public release.

---

## Category

- **Primary:** Social Networking
- **Secondary:** Utilities (optional)

(The App Store has no "Communication" category; messengers — Signal, WhatsApp,
Telegram — all sit under Social Networking. Set via `primary_category` in the
`listing` lane; secondary is optional in the UI.)

## Pricing & availability

- **Free.** No in-app purchases yet (the paid tier lands later — set up the
  subscription catalog then). Availability: all territories.

## Export compliance

Handled in code: `Info.plist` sets `ITSAppUsesNonExemptEncryption = false`,
claiming the Category 5 Part 2 mass-market exemption (standard E2E crypto via
libsignal + HTTPS — same basis as Signal/WhatsApp). This stops the "Missing
Compliance" prompt on every TestFlight build. **Confirm with legal**; if they
prefer to file an annual self-classification report instead, flip the key to
`true` and complete the export questionnaire in ASC.

---

## App Privacy ("nutrition label") — App Store Connect → App Privacy

The privacy manifest, `Speakeasy/PrivacyInfo.xcprivacy`, is the authoritative
declaration: it lists every collected data type with its Linked / Tracking /
Purpose values (every purpose is App Functionality; `NSPrivacyTracking` is
false). Anything not listed there is **Data Not Collected**. Keep the per-type
answers in the manifest only — do not maintain a second copy here.

- **Before resubmission:** update the App Store Connect App Privacy answers to
  match the manifest exactly (no more, no less). The repository manifest alone
  is not sufficient — App Store Connect does not read it.
- **Contact Info → Email Address** is declared not linked to the user: it is
  entered only if device attestation is unavailable, then passed to Vouchflow
  to deliver a one-time code; Speakeasy does not store it with the handle.
- **Identifiers → Device ID** covers the Vouchflow attestation token and the
  push token. iOS push routes through Firebase Cloud Messaging as well
  (`apps/mobile/src/push/push-notifications.ts`), so Firebase receives the
  device push identifier.
- **Tracking:** No. (No ads, no cross-app/-site tracking; analytics disabled —
  `IS_ANALYTICS_ENABLED=false` in GoogleService-Info.plist.)

## Age rating — App Store Connect → Age Rating questionnaire

It's a communication app: content is user-generated and, because chats are
end-to-end encrypted, **unmoderated by design** (the provider cannot read it).

- All content-type questions (violence, sexual content, profanity, drugs,
  gambling, horror, etc.): **None**.
- **Unrestricted web access:** No (there's no in-app browser).
- **User-generated content / can users communicate:** Yes — and it's
  unmoderated. Apple weights this toward **17+** for messengers (Signal and
  WhatsApp are both 17+). Expect a 17+ result; that's correct for an
  unmoderated E2E communication tool. Don't fight it down.

(`deliver` can automate this via `app_rating_config_path`, but Apple changed
the questionnaire in 2025 — do it once in the UI to be safe.)

---

## Screenshots — `fastlane/screenshots/en-US/`

Apple requires **6.9"** iPhone screenshots (1320×2868, iPhone 16 Pro Max);
6.5" is optional fallback. Captured from the iOS Simulator (no real PII —
seeded test conversations). High-impact set, mirroring the Android shots:

1. **Conversation list** — animal avatars; sells anonymous-identity-by-animal.
2. **A 1:1 chat** — bubble design + brand register (curated test convo).
3. **A Private Call in progress** — avatar speech rings + voice-filter chip.
4. **Voice-filter picker** (Smoke / Velvet / Glass) — the differentiator.
5. **Avatar picker** — the menagerie; the "your face is an animal" model.

## Submission gating (App Store, NOT TestFlight)

- [ ] Screenshots (≥1 at 6.9")
- [ ] Description / keywords / subtitle / promo ← `fastlane ios listing`
- [ ] Privacy policy URL ← set (`fastlane ios listing`)
- [ ] App Privacy nutrition label ← UI (above)
- [ ] Age rating ← UI (above)
- [ ] Export compliance ← Info.plist (above)
- [ ] Category ← `fastlane ios listing`
- [ ] Pricing ← UI

## Translations

en-US only for v1 (same call as Android). Add locales under
`fastlane/metadata/<locale>/` later.

## Screenshots & device family

Screenshots live in `fastlane/screenshots/en-US/` (six iPhone 6.9",
1320×2868) — generated by `fastlane/make_screenshots.py`, pushed by the
`listing` lane. The 6.9" set satisfies the iPhone requirement on its own.

**iPad:** `TARGETED_DEVICE_FAMILY` is currently **unset** in the Xcode
project, so the build defaults to **universal (iPhone + iPad = "1,2")**.
Consequences at App Store submission (not TestFlight):

- App Review will require a **separate iPad screenshot set**, and
- the app must actually run/lay out correctly on iPad.

For a phone-first v1 the recommended fix is to ship **iPhone-only**: set
`TARGETED_DEVICE_FAMILY = 1` on the `Speakeasy` target (both Debug + Release)
and rebuild. That drops the iPad screenshot + iPad-QA requirement entirely.
Decide this before the App Store submission; TestFlight is unaffected.
