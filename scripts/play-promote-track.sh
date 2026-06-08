#!/usr/bin/env bash
#
# Promote the most recent release on one Play Console track to another
# track (e.g. internal → beta, where Google's API name "beta" maps to
# what the Play Console UI calls "Open testing").
#
# Companion to scripts/play-publish.sh (AAB upload) and
# scripts/play-publish-listing.sh (store listing copy + graphics). Same
# WIF-friendly bearer-token pattern, same verbose error handling, same
# atomic-commit safety.
#
# Why this is separate:
#   The AAB upload only ever writes to ONE track (internal, per
#   release-play.yml's `TRACK: internal`). To get to Open Testing the
#   user previously had to manually click "Promote release" in Play
#   Console. This script does that promotion via REST + workflow
#   dispatch so the GitHub Actions UI / `gh workflow run` is the single
#   entry point for every step of a release.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with androidpublisher scope
#   PACKAGE_NAME     — e.g. xyz.speakeasyapp.app
#   FROM_TRACK       — source track: internal | alpha | beta
#   TO_TRACK         — destination track: alpha | beta | production
#                       (note: beta = Open Testing in the Play Console UI)
#   RELEASE_STATUS   — draft | inProgress | halted | completed
#                       'draft' = the release lands on TO_TRACK in
#                       "Ready to publish" state — you still need to
#                       click "Send to testers" in Play Console. This
#                       is the safe default for the first time we ship
#                       to a new track (the Google review only triggers
#                       on the FIRST roll-out).
#                       'completed' = auto-publishes after Google's
#                       review of the track completes (first-time-only
#                       review for Open / Production).
#
# Idempotent: re-running with the same FROM/TO drops a duplicate-
# versionCode release request, which Google rejects with a clear
# error message. Re-runs with a newer FROM_TRACK release succeed.

set -euo pipefail

: "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME env var is required}"
: "${FROM_TRACK:?FROM_TRACK env var is required (internal|alpha|beta)}"
: "${TO_TRACK:?TO_TRACK env var is required (alpha|beta|production)}"
: "${RELEASE_STATUS:?RELEASE_STATUS env var is required (draft|completed)}"

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

# ───────────────────────────────────────────────────────────────────────
# 1. Create an edit
# ───────────────────────────────────────────────────────────────────────
echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | \
          python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "  editId = $EDIT_ID"

# ───────────────────────────────────────────────────────────────────────
# 2. Read the source track to get the most recent release's
#    versionCodes + release notes
# ───────────────────────────────────────────────────────────────────────
echo "▸ Reading $FROM_TRACK track"
SOURCE_TRACK=$(api GET "$API/edits/$EDIT_ID/tracks/$FROM_TRACK")
echo "  source releases: $(echo "$SOURCE_TRACK" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("releases",[])))')"

# Pick the release with the highest versionCode — that's the most
# recently uploaded one. Encode the chosen release as a JSON object
# we'll splice into TO_TRACK's `releases` array.
PROMOTED_RELEASE=$(FROM_JSON="$SOURCE_TRACK" RELEASE_STATUS="$RELEASE_STATUS" python3 <<'PY'
import json, os, sys
src = json.loads(os.environ["FROM_JSON"])
releases = src.get("releases", [])
if not releases:
    print("::error::no releases on source track to promote", file=sys.stderr)
    sys.exit(1)
def maxvc(r):
    codes = r.get("versionCodes") or []
    return max(int(c) for c in codes) if codes else 0
chosen = max(releases, key=maxvc)
out = {
    "name": chosen.get("name") or f"promoted-vc-{maxvc(chosen)}",
    "versionCodes": chosen["versionCodes"],
    "status": os.environ["RELEASE_STATUS"],
}
# Carry release notes across if present — Google complains when the
# destination track is empty of notes for a promoted release.
if chosen.get("releaseNotes"):
    out["releaseNotes"] = chosen["releaseNotes"]
print(json.dumps(out))
PY
)
echo "  promoting versionCode(s): $(echo "$PROMOTED_RELEASE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["versionCodes"])')"

# ───────────────────────────────────────────────────────────────────────
# 3. Write the promoted release onto the destination track
# ───────────────────────────────────────────────────────────────────────
echo "▸ Writing $TO_TRACK track"
TO_TRACK_BODY=$(PROMOTED="$PROMOTED_RELEASE" TRACK="$TO_TRACK" python3 -c '
import json, os
print(json.dumps({
    "track": os.environ["TRACK"],
    "releases": [json.loads(os.environ["PROMOTED"])],
}))')
api PUT "$API/edits/$EDIT_ID/tracks/$TO_TRACK" \
    -H 'Content-Type: application/json' \
    -d "$TO_TRACK_BODY" >/dev/null

# ───────────────────────────────────────────────────────────────────────
# 4. Validate then commit
# ───────────────────────────────────────────────────────────────────────
echo "▸ Validating edit"
api POST "$API/edits/$EDIT_ID:validate" >/dev/null
echo "  ok"

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit" >/dev/null
echo "  $FROM_TRACK → $TO_TRACK promotion committed."
echo ""
echo "Status next:"
case "$RELEASE_STATUS" in
  draft)
    echo "  - Release is in 'Ready to publish' on $TO_TRACK."
    echo "  - First-time roll-out to Open Testing triggers a Google review"
    echo "    (24-48h typical). Click 'Send to testers' / 'Submit for review'"
    echo "    in Play Console once you've eyeballed the listing."
    ;;
  completed)
    echo "  - Release is set to auto-publish once Google's track review"
    echo "    finishes. First-time Open Testing roll-out → 24-48h typical."
    ;;
  *)
    echo "  - status=$RELEASE_STATUS (advanced — Play Console will show the state)."
    ;;
esac
