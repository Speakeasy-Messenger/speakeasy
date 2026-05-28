# Play Store publishing — setup reference

How the `release-play.yml` workflow auths to Google Play and uploads
the signed AAB to the Internal Testing track. Keep this in sync with
the actual GCP / Play Console state — it's the documentation pointer
for anyone (including future-me) trying to understand why this
specific dance exists.

## Components

- **GitHub Actions workflow**: `.github/workflows/release-play.yml`
  Triggers on `alpha-*` tags alongside the direct-download APK
  pipeline (`release.yml`). Builds the AAB, mints a short-lived GCP
  access token via Workload Identity Federation, uploads via the
  AndroidPublisher REST API.

- **Upload script**: `scripts/play-publish.sh`
  Bash + curl wrapping the four-step AndroidPublisher edit flow
  (create edit → upload bundle → set track release → commit).

- **GCP project**: `speakeasy-mobile-497702` (project number
  `480139204146`). Owned by `lunchbox@gmail.com`. Hosts the service
  account that the workflow impersonates.

- **Play Console**: `dani@trustysquire.ai`. Owns the Speakeasy app
  listing. Granted the SA email Release Manager role via Users and
  permissions → Invite new users.

Cross-account is intentional — Google account identity doesn't have
to match between Play Console and GCP. The bridge is the SA email
string.

## Workload Identity Federation (no static key to rotate)

The reason we don't have a service-account JSON sitting in GitHub
Secrets: GCP's "Secure by Default" organization policy blocks new
service-account key creation on personal-account projects. Even if
we could create one, static keys are the most common credential-leak
vector for service automations. WIF skips both problems — GitHub
Actions exchanges its OIDC token for a short-lived GCP access token
at workflow runtime, no shared secret.

GCP-side setup (already done, don't re-do unless rebuilding from
scratch):

- **Pool**: `projects/480139204146/locations/global/workloadIdentityPools/github-actions-pool`
- **Provider**: `.../providers/github`
  - Issuer URL: `https://token.actions.githubusercontent.com`
  - Attribute mapping: `google.subject=assertion.sub`,
    `attribute.repository=assertion.repository`,
    `attribute.actor=assertion.actor`
  - Attribute condition: `assertion.repository == "Speakeasy-Messenger/speakeasy"`
    This pins access to THIS repo only — other repos that happen to
    know the pool resource name cannot impersonate our SA.
- **Service account**: `fastlane-play-publisher@speakeasy-mobile-497702.iam.gserviceaccount.com`
  - Granted `roles/iam.workloadIdentityUser` on the principal
    `principalSet://iam.googleapis.com/projects/480139204146/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/Speakeasy-Messenger/speakeasy`

Play-Console-side setup (already done):

- SA invited via Users and permissions → Invite new users
- App permissions: **Speakeasy** → **Release manager** (only)
- Account permissions: none (don't grant account-wide admin to the SA)

## GitHub secrets used by the workflow

The Play workflow reuses the same signing secrets as the existing
direct-APK pipeline — both produce signed Android artifacts, just in
different formats (.apk vs .aab).

- `ANDROID_KEYSTORE_BASE64` — the upload keystore, base64-encoded.
  This is `speakeasy-release.keystore` from the repo root, but the
  binary should NOT be committed unless it's been wiped of password
  hashes. Confirm by running `keytool -list -v -keystore ...`.
- `ANDROID_KEYSTORE_PASSWORD` — keystore password.
- `ANDROID_KEY_ALIAS` — alias inside the keystore.
- `ANDROID_KEY_PASSWORD` — key password (often same as keystore).
- `VOUCHFLOW_WRITE_KEY` — production Vouchflow API key.

WIF needs NO secret — `id-token: write` permission is enough.

## Release lifecycle

1. Tag `alpha-0.7.0-rc.N` is pushed.
2. Two workflows fire in parallel:
   - `release.yml` builds the APK, uploads to the GitHub release.
   - `release-play.yml` builds the AAB, uploads to Play Internal Testing
     with status `draft`.
3. Direct-download testers install the APK from GitHub (existing flow,
   unchanged).
4. Play testers wait for the manual "Send to testers" click in Play
   Console — the draft status is intentional so you can sanity-check
   the AAB before it goes out.
5. To promote: Play Console → Speakeasy → Internal testing → the new
   release row → **Review release** → **Send to N testers**.

## Common failure modes + fixes

**"versionCode N has already been used"**
The Play Console rejects any AAB whose versionCode isn't strictly
greater than the highest previously-uploaded versionCode for the app.
If you uploaded something manually before the automation existed,
later automated uploads must use a higher versionCode.

`versionCode` is derived from the RC number in the tag
(`alpha-0.7.0-rc.19` → versionCode 19). If you've manually uploaded a
build with a higher number, the next RC's auto-upload will fail until
the tag number catches up.

**"Bundle is not signed with the upload key"**
The keystore in `ANDROID_KEYSTORE_BASE64` doesn't match what Play has
on file as the upload key for this app. Either the keystore in the
secret is wrong, or you uploaded a different keystore to Play App
Signing during initial setup. Fix in Play Console under
Setup → App signing → reset the upload key (you'll need Google
support's help for this).

**WIF: "Permission denied" on workloadIdentityUser**
The principalSet on the SA doesn't match the repository pushing the
tag. Check that
`Speakeasy-Messenger/speakeasy` matches your `github.repository`
exactly (case-sensitive).

**Tag-version assertion fails**
The AAB manifest's versionName/versionCode disagrees with what's in
the git tag. Usually means `build.gradle`'s `deriveVersionString`
fell back to the dev default — check that `GITHUB_REF` is set in the
build step's env and the tag matches the `alpha-*` pattern.

## Adding new testers

Play Console → Speakeasy → Internal testing → Testers tab →
**Manage email list** → paste emails (one per line). Testers get a
custom opt-in link that grants Play Store access to install the app.
Limit: 100 testers per closed track.

## Promoting to closed beta / production later

When ready to expand beyond Internal Testing:

1. Open the Internal Testing release in Play Console.
2. **Promote release** → pick Closed beta or Production.
3. The first promotion to production triggers Google's review
   (typically 1-3 days). Plan accordingly.

The workflow only ever targets Internal Testing automatically.
Beta/production promotion is a deliberate manual step.
