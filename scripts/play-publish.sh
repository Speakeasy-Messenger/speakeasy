#!/usr/bin/env bash
#
# Upload an Android App Bundle (AAB) to a Google Play Console track via
# the AndroidPublisher REST API. Called from .github/workflows/release-play.yml
# after google-github-actions/auth@v2 has minted a short-lived access token
# for the WIF-bound service account.
#
# Why curl + REST instead of `fastlane supply`:
#   Fastlane's supply expects a service_account-format JSON key, but with
#   Workload Identity Federation the credential file written by the auth
#   action is in external_account format. Adapting that needed a converter
#   shim. The REST API takes a bearer token directly, which is what the
#   auth action gives us. 50 lines of curl, no extra dependency, easier
#   to debug.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with androidpublisher scope
#   PACKAGE_NAME     — e.g. xyz.speakeasyapp.app
#   AAB_PATH         — path to the signed .aab file
#   TRACK            — internal | alpha | beta | production
#   RELEASE_NAME     — human-readable release name, shown in Play Console
#   RELEASE_STATUS   — draft | inProgress | halted | completed
#                       'draft' = uploaded but NOT auto-released. You manually
#                       click "Send to testers" in Play Console.
#                       'completed' = auto-promoted to all testers on the track.
#
# Exits non-zero on any API error. Logs the response body on each step
# so a failed run shows you exactly which API call rejected.

set -euo pipefail

: "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME env var is required}"
: "${AAB_PATH:?AAB_PATH env var is required}"
: "${TRACK:?TRACK env var is required (internal|alpha|beta|production)}"
: "${RELEASE_NAME:?RELEASE_NAME env var is required}"
: "${RELEASE_STATUS:?RELEASE_STATUS env var is required (draft|completed)}"

if [ ! -f "$AAB_PATH" ]; then
  echo "::error::AAB file not found at $AAB_PATH" >&2
  exit 1
fi

API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}"
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

# Wraps curl so failures dump the response body before exit. Without this
# a 400 from the API exits the script with no signal of what was wrong.
api() {
  local method="$1"
  local url="$2"
  shift 2
  local body
  local status
  body=$(curl -sS -w "\n%{http_code}" -X "$method" "$url" -H "$AUTH" "$@")
  status=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "::error::API call failed: $method $url → HTTP $status" >&2
    echo "$body" >&2
    exit 1
  fi
  echo "$body"
}

echo "1/4 Creating edit..."
edit_response=$(api POST "${API}/edits" -H "Content-Length: 0")
edit_id=$(echo "$edit_response" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "  edit id: $edit_id"

echo "2/4 Uploading AAB ($(du -h "$AAB_PATH" | awk '{print $1}'))..."
upload_response=$(api POST \
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}/edits/${edit_id}/bundles?uploadType=media" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${AAB_PATH}")
version_code=$(echo "$upload_response" | python3 -c "import sys, json; print(json.load(sys.stdin)['versionCode'])")
echo "  uploaded versionCode: $version_code"

echo "3/4 Setting ${TRACK} track release (${RELEASE_NAME}, status=${RELEASE_STATUS})..."
track_body=$(python3 -c "
import json, os
print(json.dumps({
  'track': os.environ['TRACK'],
  'releases': [{
    'name': os.environ['RELEASE_NAME'],
    'status': os.environ['RELEASE_STATUS'],
    'versionCodes': [str(os.environ['VERSION_CODE'])],
  }],
}))
" VERSION_CODE="$version_code" TRACK="$TRACK" RELEASE_NAME="$RELEASE_NAME" RELEASE_STATUS="$RELEASE_STATUS")

api PUT "${API}/edits/${edit_id}/tracks/${TRACK}" \
  -H "Content-Type: application/json" \
  --data "$track_body" > /dev/null
echo "  track release configured"

echo "4/4 Committing edit..."
api POST "${API}/edits/${edit_id}:commit" -H "Content-Length: 0" > /dev/null
echo "  edit committed — versionCode ${version_code} is now on the ${TRACK} track"
echo ""
echo "Play Console URL: https://play.google.com/console/u/0/developers/-/app-list?search=${PACKAGE_NAME}"
