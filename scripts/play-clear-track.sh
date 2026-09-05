#!/usr/bin/env bash
#
# Clear every release on a Play Console track via the AndroidPublisher
# REST API. Used to remove a draft / pending release that was promoted
# in error or that we no longer want surveying for review.
#
# Companion to scripts/play-publish.sh (AAB upload),
# scripts/play-publish-listing.sh (store listing), and
# scripts/play-promote-track.sh (track promotion). Same WIF auth,
# same bearer-token model, same atomic commit.
#
# Commit-review model: every edit this script creates is committed with
# `changesNotSentForReview=true`. Speakeasy's release model does NOT use
# Google review — releases commit directly. Without that query parameter
# Google auto-sends a reviewed-track edit (production / beta / Open
# Testing) for review, and the NEXT edit on that track fails hard with
# HTTP 400 INVALID_ARGUMENT: "Changes cannot be sent for review
# automatically. Please set the query parameter changesNotSentForReview
# to true." Keep the flag on every `:commit` call here.
#
# There is deliberately NO `:validate` call before the commit. Google
# documents `changesNotSentForReview` on `edits.commit` ONLY —
# `edits.validate` takes no query parameters at all — so on a reviewed
# track `:validate` fails with the exact same HTTP 400 INVALID_ARGUMENT
# no matter how well-formed the edit is, and there is no flag that can
# quiet it. `:validate` is optional; the commit rejects a bad edit on
# its own and an edit is atomic, so nothing partially applies. Do not
# reintroduce it — the guard in
# apps/mobile/src/integration/release-pipeline.test.ts fails if you do.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with androidpublisher scope
#   PACKAGE_NAME     — e.g. xyz.speakeasyapp.app
#   TRACK            — track to clear: internal | alpha | beta | production
#                       (beta = Open Testing in the Play Console UI)
#
# Effect: PUT /tracks/{track} with `releases: []`. Play Console
# immediately shows the track as having no releases. If a release was
# in "Ready to publish" / draft state, it's gone. If a release was
# already rolled out and being reviewed, this DOES NOT roll back the
# review — it cancels the pending state. Released-to-testers state
# survives across edits; clearing the track only removes draft /
# pending releases.

set -euo pipefail

: "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME env var is required}"
: "${TRACK:?TRACK env var is required (internal|alpha|beta|production)}"

API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}"
AUTH="Authorization: Bearer ${ACCESS_TOKEN}"

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

echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | \
          python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "  editId = $EDIT_ID"

echo "▸ Reading $TRACK track (pre-clear)"
PRE=$(api GET "$API/edits/$EDIT_ID/tracks/$TRACK")
echo "  pre-clear releases: $(echo "$PRE" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("releases",[])))')"

echo "▸ Writing empty releases array to $TRACK"
BODY=$(TRACK="$TRACK" python3 -c '
import json, os
print(json.dumps({"track": os.environ["TRACK"], "releases": []}))')
api PUT "$API/edits/$EDIT_ID/tracks/$TRACK" \
    -H 'Content-Type: application/json' \
    -d "$BODY" >/dev/null

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit?changesNotSentForReview=true" >/dev/null
echo "  $TRACK track cleared. Any draft / pending releases removed."
echo ""
echo "Released-to-testers history is unaffected; this only removes"
echo "the upcoming / unrolled releases that hadn't gone live yet."
