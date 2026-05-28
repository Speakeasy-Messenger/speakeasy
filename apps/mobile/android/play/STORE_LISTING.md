# Store listing — Play Console answers

Most of the listing copy lives in `fastlane/metadata/android/en-US/`
(title, descriptions, changelogs) so it's diff-able and version-
controlled. This doc covers the bits that the Fastlane metadata
schema doesn't cover — the things you set once through Play Console's
web UI.

---

## App category

**Communication**

(Same answer as the content-rating questionnaire's category
selection. Not Social, not Productivity.)

---

## Tags

Play Console asks for up to 5 tags. Pick from their fixed taxonomy:

- Messaging (primary — most users search for this)
- Encrypted communication
- Privacy
- Voice calls
- Group chat

Avoid generic tags like "Chat" — the more specific the tag, the
better the Play Store search ranking for users looking for E2E apps
specifically.

---

## Contact info

- **Email**: `hello@speakeasyapp.xyz` (or whichever inbox you
  actually monitor — Google MUST be able to reach you here for app
  enforcement notices)
- **Phone**: optional, leave blank
- **Website**: `https://speakeasyapp.xyz`
- **Privacy policy**: `https://speakeasyapp.xyz/privacy/` (confirmed
  live, branded page, 5.7 KB of real content)

---

## Graphics requirements

The Fastlane metadata layout expects these files at:

```
fastlane/metadata/android/en-US/images/
  icon.png                        # 512x512 PNG, transparent or solid
  featureGraphic.png              # 1024x500 PNG, no transparency
  phoneScreenshots/
    1_home.png                    # 16:9 portrait, 1080x1920+
    2_chat.png
    3_call.png
    4_account.png
    5_avatar-picker.png
  tabletScreenshots/              # optional, only if claiming tablet support
  tvScreenshots/                  # N/A for Speakeasy
  wearScreenshots/                # N/A for Speakeasy
```

Files NOT yet created — will land in a follow-up PR once we have
the source assets and a way to drive screenshots. Notes on each:

### Icon (512x512)

Source: the existing launcher icon at
`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`
is the right starting point but needs to be upscaled / cleaned for
Play Store's 512x512 requirement. Ideally we have a vector source
(SVG / Figma) that produces 512x512 without artifacts.

### Feature graphic (1024x500)

The hero image at the top of the Play Store listing page. Brand
canvas (dark INK background) with the wordmark + a featured
animal silhouette (the brand mark, not a specific user's avatar).
Bone-on-INK with brass accent.

### Phone screenshots (5 recommended, 8 max)

The most-impact captures:

1. **Conversation list** — shows multiple rooms with the animal
   avatars. Sells the "anonymous identity by animal" story.
2. **A 1:1 chat** — shows the bubble design, message styling, brand
   register. Use a curated test conversation, no real PII.
3. **A Private Call in progress** — shows the avatar with active
   speech rings, the voice filter indicator. Most differentiating
   feature.
4. **Account → Voice filter picker** — shows the Smoke/Velvet/Glass
   options. Reinforces the unique customization.
5. **Avatar picker** — shows the menagerie of animal avatars.
   Sells the "your face is an animal" identity model.

Captured at minimum 1080x1920 (16:9 portrait). Higher resolution is
better; Play scales down.

---

## Promotional video

Optional. Play accepts a YouTube URL. Skip for v1 — adds production
overhead without an obvious win at the alpha-tester scale we're
launching to.

---

## Translations

**en-US only** for v1. Adding translations multiplies the listing
maintenance cost (every change to title/short/full has to be
translated and approved). Add Spanish, French, German later, after
the core listing has stabilized through a few revisions.

The Fastlane metadata directory structure supports multi-locale —
just create `fastlane/metadata/android/<locale>/` alongside `en-US/`.

---

## In-app product setup

N/A — Speakeasy is free during alpha. Set up the subscription / IAP
catalog when the paid tier launches; not in this push.

---

## Submission gating

The Play Console will not let you submit to a public track (Closed
Beta, Open Beta, Production) until:

- [ ] App icon uploaded (512x512)
- [ ] Feature graphic uploaded (1024x500)
- [ ] At least 2 phone screenshots uploaded
- [ ] Short description filled
- [ ] Full description filled
- [ ] Privacy policy URL set
- [ ] Content rating questionnaire submitted
- [ ] Data safety form submitted
- [ ] Target audience set
- [ ] Categorization set

**Internal Testing track does NOT require any of these.** Internal
Testing lets you upload AABs and have 100 invited testers install
the app while the listing is still incomplete. That's the path we
ship on first — fill the listing in parallel, promote to Closed
Beta once both are ready.
