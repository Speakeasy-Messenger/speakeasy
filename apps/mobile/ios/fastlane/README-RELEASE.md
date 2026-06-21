# iOS release (fastlane)

Auth is via an **App Store Connect API key** (no Apple ID password / 2FA).
Signing is via **fastlane match** (git storage —
`Speakeasy-Messenger/speakeasy-certs`, private).

## Secrets (in the squire vault)

- `apple-asc-api / speakeasy` → `key_id`, `issuer_id`, `team_id`, `private_key` (.p8)
- `fastlane-match / speakeasy` → `passphrase`, `certs_repo`

## Required env vars at run time

| var | value |
| --- | --- |
| `ASC_KEY_ID` | `YJV2ZFM84L` |
| `ASC_ISSUER_ID` | `03932458-ce80-4fea-8488-8f90e9b7e26d` |
| `ASC_KEY_CONTENT` | the `.p8` contents (PEM, with newlines) |
| `MATCH_PASSWORD` | the match passphrase |

(Locally: read these from the web vault. In CI: GitHub Actions secrets.)

## First-time setup (run once, on the Mac)

```sh
cd ~/speakeasy/apps/mobile/ios
bundle install                      # installs fastlane + cocoapods
USE_FRAMEWORKS=static pod install   # LibSignalClient is a Swift pod
bundle exec fastlane ios certs      # creates the dist cert + profile in speakeasy-certs
```

(The app record must exist in App Store Connect for `xyz.speakeasyapp.app`
before the first `beta`/`release` — created via `fastlane produce` or the
ASC UI.)

## Lanes

- `bundle exec fastlane ios beta` — build + upload to **TestFlight**
- `bundle exec fastlane ios release` — build + upload to the **App Store**
  (not auto-submitted for review; flip `submit_for_review` when ready)
- `bundle exec fastlane ios certs` — create/refresh signing material (local)
- `bundle exec fastlane ios signing` — read-only match sync (CI)

## Status

Scaffold only — **not yet validated**. The first `certs` + `beta` run on
the Mac will shake out signing/profile details before CI is wired.
