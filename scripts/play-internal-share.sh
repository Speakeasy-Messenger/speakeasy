#!/usr/bin/env bash
#
# Upload the AAB to Google Play **Internal App Sharing** — a Play-hosted,
# review-FREE install link. This is the "update behind the review" path:
# when a normal track release is held by a Google review (e.g. an
# App-content / USE_FULL_SCREEN_INTENT declaration review), testers can
# still install the latest build via the Internal App Sharing link, through
# the Play Store, without sideloading a raw APK.
#
# Best-effort by design: this NEVER fails the build. If Internal App
# Sharing isn't enabled / the publisher service account isn't an authorized
# uploader, it logs a warning explaining the one-time Play Console setup and
# exits 0 so the rest of the release pipeline is unaffected.
#
# Required env:
#   ACCESS_TOKEN  — OAuth token with the androidpublisher scope (same one
#                   play-publish.sh uses; Internal App Sharing is covered).
#   PACKAGE_NAME  — e.g. xyz.speakeasyapp.app
#   AAB_PATH      — path to the signed .aab
# Optional env:
#   RELEASE_NAME  — human label for logs / broadcast (e.g. the tag)
#   ADMIN_TOKEN   — if set, broadcast the link to testers via @speaker
#                   (same mechanism release.yml uses for build announcements)

set -uo pipefail

: "${ACCESS_TOKEN:?ACCESS_TOKEN required}"
: "${PACKAGE_NAME:?PACKAGE_NAME required}"
: "${AAB_PATH:?AAB_PATH required}"
RELEASE_NAME="${RELEASE_NAME:-build}"

if [ ! -f "$AAB_PATH" ]; then
  echo "::warning::Internal App Sharing: AAB not found at $AAB_PATH — skipping."
  exit 0
fi

echo "Uploading $(du -h "$AAB_PATH" | awk '{print $1}') AAB to Internal App Sharing…"
resp=$(curl -sS -w $'\n%{http_code}' -X POST \
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}/internalappsharing/artifacts/aab?uploadType=media" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${AAB_PATH}")
code=$(printf '%s' "$resp" | tail -n1)
body=$(printf '%s' "$resp" | sed '$d')

if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
  echo "::warning::Internal App Sharing upload failed (HTTP $code)."
  echo "::warning::One-time setup: Play Console → Setup → Internal app sharing → enable, and authorize the publisher service account as an uploader."
  echo "$body"
  exit 0
fi

url=$(printf '%s' "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('downloadUrl',''))" 2>/dev/null || true)
if [ -z "$url" ]; then
  echo "::warning::Internal App Sharing upload returned no downloadUrl."
  echo "$body"
  exit 0
fi

echo "Internal App Sharing link (review-free): $url"
{
  echo "### Internal App Sharing — review-free install"
  echo ""
  echo "**${RELEASE_NAME}** installs via Play, bypassing the track review:"
  echo ""
  echo "$url"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "Broadcasting the link via @speaker…"
  curl -fsS -X POST "https://api.speakeasyapp.xyz/v1/broadcast" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"New build ${RELEASE_NAME} is available (review-free) — ${url}\"}" \
    || echo "::warning::@speaker broadcast failed (non-fatal)."
fi
