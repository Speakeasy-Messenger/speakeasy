#!/bin/bash
# Run 13-email-fallback-enroll-ios.yaml on a real iPhone via BrowserStack
# App Automate (Maestro runner), then print a PASS/FAIL verdict and where
# the video and log live.
#
# The IPA and the flow zip come from the "BrowserStack iOS email-fallback
# harness" workflow's artifact. Credentials are NOT read from disk: export
# BROWSERSTACK_BASIC with a base64 "user:key" pair, which is what an egress
# grant minted from the Trusty Squire vault hands you. BROWSERSTACK_USER +
# BROWSERSTACK_KEY also work when you already have them in the environment.
#
# Per-run values (handle, inbox, code source) are patched into the flow's
# own `env:` block before upload rather than passed as build capabilities —
# the flow then carries its inputs with it, so the zip in the BrowserStack
# build is a complete record of what was executed.
#
# THE WHOLE FLOW, UNATTENDED
#   Waypoint C needs the six-digit code, which does not exist until the
#   device is already on the code screen and dies five minutes later — so
#   it cannot be patched in here with the rest. With RESEND_API_KEY set
#   this starts `otp-relay.py` (watches the inbox through Vouchflow's
#   sender) behind a `cloudflared` quick tunnel, and patches that public
#   URL in as OTP_URL. The device fetches the code itself, mid-run.
#
#   Without RESEND_API_KEY the run still proves waypoints A and B and
#   stops at the code screen, exactly as before. Pass FALLBACK_OTP=123456
#   to drive waypoint C from a code read by hand instead.
#
#   The tunnel is deliberately throwaway: it exists for one build, serves
#   one single-use code that expires in five minutes, and nothing is
#   written to disk. Both the relay and the tunnel are killed on exit.
#
# Usage:
#   IPA=Speakeasy.ipa SUITE=speakeasy-ios-fallback.zip \
#   FALLBACK_EMAIL=you@example.com RESEND_API_KEY=re_... \
#   [FALLBACK_OTP=123456] [HANDLE=fallbackqa] \
#   ./browserstack-ios-fallback.sh
#
# Devices: an iPhone, because the app is built iPhone-only
# (`UIDeviceFamily`) and BrowserStack rejects the IPA on any iPad with
# `422 BROWSERSTACK_APP_BUILT_FOR_IPHONE`. The reviewer's hardware was an
# iPad, but the un-attestable condition this flow needs comes from the
# farm wipe rather than the form factor, and farm iPhones are wiped the
# same way — no passcode, no enrolled biometric. Running this on an iPad
# would first require the app to declare iPad support, which is a product
# decision, not a harness one.
#
# Override with a current non-beta pair from /app-automate/devices.json:
#   DEVICES='["iPhone 14-18"]'

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
API=https://api-cloud.browserstack.com/app-automate
FLOW=13-email-fallback-enroll-ios.yaml
IPA="${IPA:?set IPA to the signed .ipa path}"
SUITE="${SUITE:?set SUITE to the Maestro flow zip path}"
HANDLE="${HANDLE:-fallbackqa$RANDOM}"
FALLBACK_EMAIL="${FALLBACK_EMAIL:?set FALLBACK_EMAIL to an inbox you can read}"
FALLBACK_OTP="${FALLBACK_OTP:-SKIP}"
# Exported: the payload heredoc below reads this out of the environment.
export DEVICES="${DEVICES:-[\"iPhone 15-17\"]}"

if [ -z "${BROWSERSTACK_BASIC:-}" ]; then
  BROWSERSTACK_BASIC=$(printf '%s:%s' \
    "${BROWSERSTACK_USER:?}" "${BROWSERSTACK_KEY:?}" | base64 -w0)
fi
AUTH=(-H "Authorization: Basic ${BROWSERSTACK_BASIC}")

relay_pid=""
tunnel_pid=""
work=$(mktemp -d)
cleanup() {
  [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null || true
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# Call the BrowserStack API and pull one field out of the JSON reply.
# Fails with the HTTP status and the raw body when the answer is not JSON.
# Worth the few lines: a wrong path answers with an HTML 404, and feeding
# that straight into a JSON parser reports a decode error at column 1
# rather than "404" -- which is how the build endpoint's platform scoping
# (/maestro/v2/ios/build, not /maestro/v2/build) survived to a real run.
bs_api() {
  local echo_body=0
  if [ "$1" = "--echo" ]; then
    echo_body=1
    shift
  fi
  local field=$1
  shift
  local body="$work/api-response" code
  code=$(curl -sS -o "$body" -w '%{http_code}' "${AUTH[@]}" "$@")
  if [ "$echo_body" -eq 1 ]; then
    echo "  response (HTTP $code):" >&2
    sed -e 's/^/    /' "$body" >&2
    # Responses are not newline-terminated; without this the next line
    # runs onto the end of the body.
    echo >&2
  fi
  FIELD="$field" CODE="$code" python3 - "$body" <<'PY'
import json, os, sys

raw = open(sys.argv[1]).read()
field, code = os.environ["FIELD"], os.environ["CODE"]
try:
    data = json.loads(raw)
except ValueError:
    sys.exit(f"!! BrowserStack answered HTTP {code} with non-JSON:\n{raw[:400]}")
if field not in data:
    sys.exit(f"!! BrowserStack answered HTTP {code} without {field!r}:\n"
             f"{json.dumps(data)[:400]}")
print(data[field])
PY
}

# ─── OTP source ───────────────────────────────────────────────────────
OTP_URL=""
if [ "$FALLBACK_OTP" != "SKIP" ]; then
  echo "→ OTP: using the code passed in FALLBACK_OTP"
elif [ -n "${RESEND_API_KEY:-}" ]; then
  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  token=$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')

  echo "→ OTP: starting relay on 127.0.0.1:$port"
  OTP_RELAY_PORT="$port" OTP_RELAY_TOKEN="$token" \
  OTP_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  RESEND_API_KEY="$RESEND_API_KEY" FALLBACK_EMAIL="$FALLBACK_EMAIL" \
    python3 "$here/otp-relay.py" &
  relay_pid=$!

  echo "→ OTP: opening cloudflared quick tunnel"
  cloudflared tunnel --url "http://127.0.0.1:$port" \
    --no-autoupdate >"$work/tunnel.log" 2>&1 &
  tunnel_pid=$!

  for _ in $(seq 1 60); do
    base=$(grep -ohE 'https://[a-z0-9-]+\.trycloudflare\.com' \
      "$work/tunnel.log" | head -1 || true)
    [ -n "$base" ] && break
    sleep 1
  done
  if [ -z "${base:-}" ]; then
    echo "!! cloudflared did not report a tunnel URL:" >&2
    tail -20 "$work/tunnel.log" >&2
    exit 1
  fi
  OTP_URL="$base/$token/otp"
  # Prove the device-facing path works before spending a build on it.
  # Retried, because a just-created trycloudflare.com hostname takes a few
  # seconds to resolve: probing once and immediately reports "not
  # reachable" and exits before the upload, for a tunnel that is about to
  # come up. A probe that does resolve blocks ~5s in the relay's own wait,
  # so this settles quickly once DNS has caught up.
  reachable=0
  for _ in $(seq 1 18); do
    if curl -sS --max-time 20 -o /dev/null "$OTP_URL" 2>/dev/null; then
      reachable=1
      break
    fi
    sleep 5
  done
  if [ "$reachable" -ne 1 ]; then
    echo "!! relay is not reachable through the tunnel after ~90s" >&2
    tail -20 "$work/tunnel.log" >&2
    exit 1
  fi
  # The token is not echoed: it guards the endpoint serving the code.
  echo "  tunnel up at $base (relay path withheld)"
else
  echo "→ OTP: no RESEND_API_KEY and no FALLBACK_OTP —"
  echo "   this run proves waypoints A and B only and stops at the code screen."
fi

# ─── Patch the flow's own env block ───────────────────────────────────
unzip -q "$SUITE" -d "$work/suite"
target=$(find "$work/suite" -name "$FLOW")
test -n "$target"
sed -i.bak \
  -e "s|^  HANDLE: .*|  HANDLE: ${HANDLE}|" \
  -e "s|^  FALLBACK_EMAIL: .*|  FALLBACK_EMAIL: ${FALLBACK_EMAIL}|" \
  -e "s|^  FALLBACK_OTP: .*|  FALLBACK_OTP: ${FALLBACK_OTP}|" \
  -e "s|^  OTP_URL: .*|  OTP_URL: '${OTP_URL}'|" \
  "$target"
rm -f "$target.bak"
# Echoed so the run's inputs are visible, with the relay's guard token
# masked — the log of a proof run gets pasted into PRs.
sed -n '/^env:/,/^---/p' "$target" \
  | sed -e "s|\(trycloudflare\.com\)/.*|\1/<redacted>/otp'|"
patched="$work/suite.zip"
(cd "$work/suite" && zip -qr "$patched" .)

echo "→ uploading app: $IPA"
app_url=$(bs_api app_url -F "file=@${IPA}" "$API/upload")
echo "  $app_url"

echo "→ uploading flows"
suite_url=$(bs_api test_suite_url -F "file=@${patched}" "$API/maestro/v2/test-suite")
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
# Platform-scoped: /maestro/v2/ios/build, not /maestro/v2/build. The
# unscoped path exists in neither form and answers with an HTML 404.
# Only the trigger is scoped this way -- the /maestro/v2/builds/{id}
# poll below is platform-agnostic and correct as written.
# --echo: the raw body is printed before build_id is pulled out of it,
# because the two failures this endpoint has already produced — an HTML
# 404 from the unscoped path, and `422 BROWSERSTACK_APP_BUILT_FOR_IPHONE`
# from an iPad device — are both explained entirely by the response and
# by nothing else the script prints.
build=$(bs_api --echo build_id -H 'Content-Type: application/json' -d "$payload" \
  "$API/maestro/v2/ios/build")
echo "  build $build"

echo "→ waiting"
while :; do
  status=$(curl -sS "${AUTH[@]}" "$API/maestro/v2/builds/$build" \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status","?"))
except ValueError: print("?")')
  echo "  $status"
  case "$status" in
    running|queued|'?') sleep 20 ;;
    *) break ;;
  esac
done

curl -sS "${AUTH[@]}" "$API/maestro/v2/builds/$build" >"$work/result.json"

# ─── Verdict ──────────────────────────────────────────────────────────
# Derived from the per-testcase counters rather than the top-level status
# string alone: BrowserStack does not document the full set of values that
# string can take, but the counters are unambiguous, and a build whose
# flow never ran at all must not read as a pass.
BUILD_ID="$build" python3 - "$work/result.json" <<'PY'
import json, os, sys

result = json.load(open(sys.argv[1]))
totals = {}
for device in result.get("devices") or []:
    for session in device.get("sessions") or []:
        for key, value in (session.get("testcases") or {}).items():
            if isinstance(value, int):
                totals[key] = totals.get(key, 0) + value

status = str(result.get("status", "?"))
passed = totals.get("passed", 0)
bad = sum(totals.get(k, 0) for k in ("failed", "error", "timedout"))

print()
print(f"build id:   {os.environ['BUILD_ID']}")
print(f"video+log:  https://app-automate.browserstack.com/builds/{os.environ['BUILD_ID']}")
print(f"status:     {status}")
print(f"testcases:  {totals or 'none reported'}")

ok = passed >= 1 and bad == 0 and status not in ("failed", "error", "timedout")
print(f"verdict:    {'PASS' if ok else 'FAIL'}")
if not ok:
    print()
    print("Waypoint A/B failing means the app never offered the fallback or")
    print("never got a session; waypoint C failing means the code was typed")
    print("but enrollment did not land. Read the video before triaging.")
sys.exit(0 if ok else 1)
PY
