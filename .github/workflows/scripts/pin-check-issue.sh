#!/usr/bin/env bash
# Shared helper for .github/workflows/vouchflow-pin-check.yml: open an issue
# with the given title, or comment on the already-open issue with the same
# title (stable titles keep the alarm from spamming duplicates).
#
# Usage: pin-check-issue.sh "<title>" <body-file>
set -euo pipefail

TITLE=$1
BODY_FILE=$2

# Exact-title match (not --search, whose phrase handling mangles punctuation
# in titles like "FAILED: a committed pin …").
NUMBER=$(gh issue list -R "$GITHUB_REPOSITORY" --state open --limit 200 \
  --json number,title | python3 -c '
import json, os, sys
title = os.environ["TITLE"]
issues = json.load(sys.stdin)
print(next((str(i["number"]) for i in issues if i["title"] == title), ""))
')

if [ -n "$NUMBER" ]; then
  gh issue comment "$NUMBER" --body-file "$BODY_FILE"
  echo "Commented on existing issue #$NUMBER."
else
  URL=$(gh issue create --title "$TITLE" --body-file "$BODY_FILE")
  echo "Created issue: $URL"
fi
