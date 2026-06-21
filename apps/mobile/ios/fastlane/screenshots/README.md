# App Store screenshots

`en-US/*.png` — six iPhone **6.9"** (1320×2868) marketing screenshots, the
iOS counterpart of the Android Play set
(`fastlane/metadata/android/en-US/images/phoneScreenshots`). Same six scenes
and captions, reframed for iOS (iPhone shell + Dynamic Island + iOS status
bar) on the brand aubergine gradient with the brass highlight.

Consumed by `fastlane ios listing` / `.github/workflows/listing-ios.yml`
(`deliver` auto-maps 1320×2868 → the 6.9" display slot). RGB, no alpha
(Apple rejects screenshots with an alpha channel).

## Regenerate

```sh
cd apps/mobile/ios
python3 fastlane/make_screenshots.py
```

The in-frame app captures are sourced from the Android RN build
(`…/phoneScreenshots-source`) — the React Native UI renders identically
across platforms; only the OS chrome (status/nav bars) is cropped and
replaced with iOS chrome. To regenerate from genuine iOS-simulator captures
later, drop 1320×2868 (or any 6.9") PNGs straight into `en-US/` — the names
just have to sort in display order.

## Scope note

Only the 6.9" set is provided. That satisfies the iPhone requirement on its
own. **iPad** screenshots are required only if the app ships as
iPad-compatible — see the `TARGETED_DEVICE_FAMILY` note in
`apps/mobile/ios/STORE_LISTING.md`.
