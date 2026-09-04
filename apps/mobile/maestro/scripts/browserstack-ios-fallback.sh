#!/bin/bash
# Run 13-email-fallback-enroll-ios.yaml on a real iPad via BrowserStack
# App Automate (Maestro runner), then print where the video and log live.
#
# The IPA and the flow zip come from the "BrowserStack iOS email-fallback
# harness" workflow's artifact. Credentials are NOT read from disk: export
# BROWSERSTACK_BASIC with a base64 "user:key" pair, which is what an egress
# grant minted from the Trusty Squire vault hands you. BROWSERSTACK_USER +
# BROWSERSTACK_KEY also work when you already have them in the environment.
#
# Per-run values (handle, inbox, code) are patched into the flow's own `env:`
# block before upload rather than passed as build capabilities — the flow
# then carries its inputs with it, so the zip in the BrowserStack build is a
# complete record of what was executed.
#
# Usage:
#   IPA=Speakeasy.ipa SUITE=speakeasy-ios-fallback.zip \
#   FALLBACK_EMAIL=you@example.com [FALLBACK_OTP=123456] [HANDLE=fallbackqa] \
#   ./browserstack-ios-fallback.sh
#
# Devices: an iPad Air is closest to the review hardware. Override with
#   DEVICES='["iPad Air 6-17"]'

set -euo pipefail

API=https://api-cloud.browserstack.com/app-automate
FLOW=13-email-fallback-enroll-ios.yaml
IPA="${IPA:?set IPA to the signed .ipa path}"
SUITE="${SUITE:?set SUITE to the Maestro flow zip path}"
HANDLE="${HANDLE:-fallbackqa$RANDOM}"
FALLBACK_EMAIL="${FALLBACK_EMAIL:?set FALLBACK_EMAIL to an inbox you can read}"
FALLBACK_OTP="${FALLBACK_OTP:-SKIP}"
DEVICES="${DEVICES:-[\"iPad Air 5-26\"]}"

if [ -z "${BROWSERSTACK_BASIC:-}" ]; then
  BROWSERSTACK_BASIC=$(printf '%s:%s' \
    "${BROWSERSTACK_USER:?}" "${BROWSERSTACK_KEY:?}" | base64 -w0)
fi
AUTH=(-H "Authorization: Basic ${BROWSERSTACK_BASIC}")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unzip -q "$SUITE" -d "$work"
target=$(find "$work" -name "$FLOW")
test -n "$target"
sed -i.bak \
  -e "s|^  HANDLE: .*|  HANDLE: ${HANDLE}|" \
  -e "s|^  FALLBACK_EMAIL: .*|  FALLBACK_EMAIL: ${FALLBACK_EMAIL}|" \
  -e "s|^  FALLBACK_OTP: .*|  FALLBACK_OTP: ${FALLBACK_OTP}|" \
  "$target"
rm -f "$target.bak"
grep -A3 '^env:' "$target"
patched="$work/suite.zip"
(cd "$work" && zip -qr "$patched" . -x 'suite.zip')

echo "→ uploading app: $IPA"
app_url=$(curl -sS "${AUTH[@]}" -F "file=@${IPA}" "$API/upload" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["app_url"])')
echo "  $app_url"

echo "→ uploading flows"
suite_url=$(curl -sS "${AUTH[@]}" -F "file=@${patched}" "$API/maestro/v2/test-suite" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["test_suite_url"])')
echo "  $suite_url"

echo "→ starting build on $DEVICES"
payload=$(APP="$app_url" TS="$suite_url" FLOW="$FLOW" python3 - <<'PY'
import json, os
print(json.dumps({
    "app": os.environ["APP"],
    "testSuite": os.environ["TS"],
    "devices": json.loads(os.environ["DEVICES"]),
    "execute": [os.environ["FLOW"]],
    "project": "speakeasy-email-fallback",
    "buildTag": "onboarding-email-fallback",
    "deviceLogs": True,
    "video": True,
}))
PY
)
build=$(curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -d "$payload" \
  "$API/maestro/v2/build" | python3 -c 'import json,sys; print(json.load(sys.stdin)["build_id"])')
echo "  build $build"

echo "→ waiting"
while :; do
  status=$(curl -sS "${AUTH[@]}" "$API/maestro/v2/builds/$build" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status","?"))')
  echo "  $status"
  case "$status" in
    running|queued|'?') sleep 20 ;;
    *) break ;;
  esac
done

echo "→ result"
curl -sS "${AUTH[@]}" "$API/maestro/v2/builds/$build" | python3 -m json.tool
echo
echo "Session video + device log: https://app-automate.browserstack.com/builds/$build"
