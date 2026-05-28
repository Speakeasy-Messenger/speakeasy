#!/usr/bin/env bash
#
# Upload the Play Console store listing (title, descriptions, icon,
# feature graphic, phone screenshots) via the AndroidPublisher REST API.
# Companion to scripts/play-publish.sh — same auth pattern, same
# verbose error handling, same WIF-friendly token-only model.
#
# Why this is separate from the AAB upload:
#   - AAB uploads happen on every `alpha-*` tag (release-play.yml).
#   - Listing edits happen rarely — a copy revision, a new screenshot,
#     a re-rendered icon. Mixing them onto every tag push would publish
#     incidental graphics-folder changes on every RC. So we trigger
#     this one manually via workflow_dispatch.
#
# Why curl + REST instead of `fastlane supply`:
#   Same reason as the AAB script: with Workload Identity Federation
#   the credential is an OAuth access token, not a service-account
#   JSON. fastlane supply doesn't accept bearer tokens. The REST API
#   takes the token in `Authorization: Bearer`, so 60 lines of curl
#   beats a 200MB Ruby + bundler dependency.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with androidpublisher scope
#   PACKAGE_NAME     — e.g. xyz.speakeasyapp.app
#   METADATA_DIR     — path to fastlane/metadata/android (the parent of
#                      the per-locale dirs like en-US/)
#   LANGUAGE         — locale code, e.g. en-US
#
# All actions land in a SINGLE Play Console "edit" which the script
# commits as draft at the end. Nothing goes live until the listing edit
# is committed — and even after commit, the store listing updates
# instantly while the AAB release status (separate edit dimension) is
# unaffected.

set -euo pipefail

: "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME env var is required}"
: "${METADATA_DIR:?METADATA_DIR env var is required (path to fastlane/metadata/android)}"
: "${LANGUAGE:?LANGUAGE env var is required (e.g. en-US)}"

LOCALE_DIR="$METADATA_DIR/$LANGUAGE"
IMAGES_DIR="$LOCALE_DIR/images"

for required in "$LOCALE_DIR/title.txt" "$LOCALE_DIR/short_description.txt" \
                "$LOCALE_DIR/full_description.txt" "$IMAGES_DIR/icon.png" \
                "$IMAGES_DIR/featureGraphic.png"; do
  if [ ! -f "$required" ]; then
    echo "::error::missing required listing asset: $required" >&2
    exit 1
  fi
done

API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}"
UPLOAD_API="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}"
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

# Wrap curl so any non-2xx dumps the response body before exit. Without
# this a 400 from the API just exits with no signal of what was wrong.
api() {
  local method="$1" url="$2"
  shift 2
  local body status
  body=$(curl -sS -w "\n%{http_code}" -X "$method" "$url" -H "$AUTH" "$@")
  status=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "::error::API call failed: $method $url → HTTP $status" >&2
    echo "$body" >&2
    return 1
  fi
  echo "$body"
}

# ───────────────────────────────────────────────────────────────────────
# 1. Create an edit
# ───────────────────────────────────────────────────────────────────────
echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | \
          python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "  editId = $EDIT_ID"

# ───────────────────────────────────────────────────────────────────────
# 2. Update listing text
# ───────────────────────────────────────────────────────────────────────
echo "▸ Updating listing text ($LANGUAGE)"
TITLE=$(cat "$LOCALE_DIR/title.txt")
SHORT=$(cat "$LOCALE_DIR/short_description.txt")
FULL=$(cat "$LOCALE_DIR/full_description.txt")

# Build the JSON body via python so we get proper escaping. The
# title/desc fields routinely contain quotes, em-dashes, newlines —
# anything bash heredoc-y would mangle.
LISTING_JSON=$(LANG="$LANGUAGE" TITLE="$TITLE" SHORT="$SHORT" FULL="$FULL" \
  python3 -c '
import json, os
print(json.dumps({
    "language": os.environ["LANG"],
    "title": os.environ["TITLE"].rstrip("\n"),
    "shortDescription": os.environ["SHORT"].rstrip("\n"),
    "fullDescription": os.environ["FULL"].rstrip("\n"),
}))')

api PUT "$API/edits/$EDIT_ID/listings/$LANGUAGE" \
    -H 'Content-Type: application/json' \
    -d "$LISTING_JSON" >/dev/null
echo "  title=$(echo "$TITLE" | wc -c | tr -d ' ') chars / short=$(echo "$SHORT" | wc -c | tr -d ' ') / full=$(echo "$FULL" | wc -c | tr -d ' ')"

# ───────────────────────────────────────────────────────────────────────
# 3. Upload images
# ───────────────────────────────────────────────────────────────────────
# For each image-type, clear the existing set then upload the new ones.
# This avoids accumulating stale assets in Play Console (the API never
# auto-replaces; it appends).
upload_image() {
  local type="$1" path="$2"
  local ct="image/png"
  case "$path" in *.jpg|*.jpeg) ct="image/jpeg" ;; esac
  echo "  ↑ $type ← $(basename "$path") ($ct)"
  api POST "$UPLOAD_API/edits/$EDIT_ID/listings/$LANGUAGE/$type?uploadType=media" \
      -H "Content-Type: $ct" \
      --data-binary "@$path" >/dev/null
}

clear_image_set() {
  local type="$1"
  api DELETE "$API/edits/$EDIT_ID/listings/$LANGUAGE/$type" >/dev/null
}

echo "▸ Uploading icon"
clear_image_set icon
upload_image icon "$IMAGES_DIR/icon.png"

echo "▸ Uploading feature graphic"
clear_image_set featureGraphic
upload_image featureGraphic "$IMAGES_DIR/featureGraphic.png"

echo "▸ Uploading phone screenshots"
clear_image_set phoneScreenshots
# Sorted by filename so 1_door, 2_avatar-picker, ... land in carousel
# order. Play Console preserves upload order within an image-type.
for shot in $(ls "$IMAGES_DIR/phoneScreenshots"/* 2>/dev/null | sort); do
  upload_image phoneScreenshots "$shot"
done

# ───────────────────────────────────────────────────────────────────────
# 4. Validate, then commit the edit
# ───────────────────────────────────────────────────────────────────────
echo "▸ Validating edit"
api POST "$API/edits/$EDIT_ID:validate" >/dev/null
echo "  ok"

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit" >/dev/null
echo "  Listing updates are live in Play Console."
echo ""
echo "What changed:"
echo "  - title, short description, full description ($LANGUAGE)"
echo "  - icon (512×512)"
echo "  - feature graphic (1024×500)"
echo "  - phone screenshots (carousel order)"
echo ""
echo "Track release status (Closed / Open / Production) is unaffected —"
echo "this script only edits the store-listing dimension."
