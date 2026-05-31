#!/usr/bin/env bash
#
# Roll out or modify the most recent release on a Play Console track
# via the AndroidPublisher REST API.
#
# Use cases:
#
#   1. Send a draft release for Google review without clicking
#      anything in Play Console. Set `RELEASE_STATUS=completed`
#      (auto-publish after review) or `inProgress` (staged rollout).
#
#   2. Add or update release notes on the active release without
#      changing its status. Set `RELEASE_NOTES_TEXT` and leave
#      `RELEASE_STATUS` empty.
#
#   3. Both at once — set the notes and submit for review in one
#      atomic edit.
#
# Companion to scripts/play-publish.sh (AAB upload), play-publish-
# listing.sh (store listing), play-promote-track.sh (track-to-track
# promotion), and play-clear-track.sh (wipe). Same WIF-friendly
# bearer-token pattern.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with androidpublisher scope
#   PACKAGE_NAME     — e.g. xyz.speakeasyapp.app
#   TRACK            — internal | alpha | beta | production
#                       (beta = Open Testing in the Play Console UI)
#
# Optional environment:
#   RELEASE_STATUS   — draft | inProgress | halted | completed
#                       Omit to preserve the current status (e.g. when
#                       only updating release notes).
#                       completed = auto-publish after review.
#                       inProgress = staged rollout; pair with
#                       USER_FRACTION (e.g. 0.1 for 10%).
#                       halted = pause an active rollout.
#                       draft = unship; release stays as
#                       "Ready to publish" awaiting another manual
#                       trigger.
#   USER_FRACTION    — 0.0–1.0; only used with RELEASE_STATUS=inProgress.
#                       Defaults to 1.0 (full rollout) if omitted.
#   RELEASE_NOTES_TEXT — free-text release notes. Omit to leave
#                       existing notes untouched.
#   RELEASE_NOTES_LANGUAGE — locale tag for the notes, defaults to en-US.
#
# Why this is separate from play-promote-track.sh:
#   `promote` moves a release between tracks. This script modifies a
#   release IN PLACE on a single track. The two operations are
#   distinct in the Play API surface and got tangled together in our
#   first iteration of the pipeline — the Open Testing rc.34 release
#   ended up stuck in a paused / "Ready to publish" limbo because we
#   had no API path to advance its status without going through the
#   Console UI. This script closes that gap.

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

echo "▸ Reading $TRACK track"
CURRENT=$(api GET "$API/edits/$EDIT_ID/tracks/$TRACK")
RELEASE_COUNT=$(echo "$CURRENT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("releases", [])))')
echo "  releases on track: $RELEASE_COUNT"
if [ "$RELEASE_COUNT" = "0" ]; then
  echo "::error::no releases on $TRACK — nothing to modify. Did the promote step run first?" >&2
  exit 1
fi

# Build the modified release JSON inline via python. We:
#   1. Pick the release with the highest versionCode (most recent).
#   2. Apply RELEASE_STATUS if provided, else preserve existing.
#   3. Apply USER_FRACTION if provided + status=inProgress, else omit.
#   4. Apply RELEASE_NOTES_TEXT (with given LANGUAGE) if provided,
#      else preserve existing notes.
#   5. PUT the track with releases=[modified] — for status=halted
#      promotion the API requires the full final state, so we keep
#      ONLY the chosen release and let the API garbage-collect the
#      rest. This matches play-clear-track / play-promote-track
#      semantics: a track-write is a full replacement.
echo "▸ Building modified release payload"
MODIFIED=$(
  CURRENT_JSON="$CURRENT" \
  TRACK="$TRACK" \
  RELEASE_STATUS="${RELEASE_STATUS:-}" \
  USER_FRACTION="${USER_FRACTION:-}" \
  RELEASE_NOTES_TEXT="${RELEASE_NOTES_TEXT:-}" \
  RELEASE_NOTES_LANGUAGE="${RELEASE_NOTES_LANGUAGE:-en-US}" \
  python3 <<'PY'
import json, os, sys

current = json.loads(os.environ["CURRENT_JSON"])
releases = current.get("releases", [])
if not releases:
    print("::error::empty releases array — guard above should have caught this", file=sys.stderr)
    sys.exit(1)

def maxvc(r):
    codes = r.get("versionCodes") or []
    return max(int(c) for c in codes) if codes else 0

chosen = max(releases, key=maxvc)

# Status: explicit override or preserve.
status_override = os.environ.get("RELEASE_STATUS") or None
if status_override:
    chosen["status"] = status_override

# userFraction is only valid for status=inProgress. Strip it on
# anything else so the API doesn't 400.
uf = os.environ.get("USER_FRACTION") or None
if chosen.get("status") == "inProgress":
    if uf is not None and uf != "":
        chosen["userFraction"] = float(uf)
    elif "userFraction" not in chosen:
        chosen["userFraction"] = 1.0
else:
    chosen.pop("userFraction", None)

# Release notes: only modify when explicit text was provided.
notes_text = os.environ.get("RELEASE_NOTES_TEXT") or None
if notes_text:
    lang = os.environ["RELEASE_NOTES_LANGUAGE"]
    chosen["releaseNotes"] = [{"language": lang, "text": notes_text}]

print(json.dumps({"track": os.environ["TRACK"], "releases": [chosen]}))
PY
)

# Echo what we're about to push for the workflow log — operators
# reviewing the run want to see the status + version + notes mutation
# without grepping the full JSON.
echo "$MODIFIED" | python3 <<'PY'
import json, sys
body = json.load(sys.stdin)
r = body["releases"][0]
print("  → versionCode(s): " + str(r.get("versionCodes")))
print("  → status:         " + str(r.get("status")))
uf = r.get("userFraction")
if uf is not None:
    print("  → userFraction:   " + str(uf))
notes = r.get("releaseNotes") or []
if notes:
    snippet = notes[0]["text"][:80].replace("\n", " ")
    print("  → releaseNotes:   [" + notes[0]["language"] + "] " + snippet + "…")
PY

echo "▸ Writing modified release to $TRACK"
api PUT "$API/edits/$EDIT_ID/tracks/$TRACK" \
    -H 'Content-Type: application/json' \
    -d "$MODIFIED" >/dev/null

echo "▸ Validating edit"
api POST "$API/edits/$EDIT_ID:validate" >/dev/null

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit" >/dev/null
echo "  $TRACK modification committed."
