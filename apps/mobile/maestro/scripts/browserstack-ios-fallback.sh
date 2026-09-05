#!/bin/bash
# Run 13-email-fallback-enroll-ios.yaml on a real iPad via BrowserStack
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
# Devices: an iPad Air is closest to the review hardware. Override with
#   DEVICES='["iPad Air 6-17"]'

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
export DEVICES="${DEVICES:-[\"iPad Air 5-26\"]}"

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
  if ! curl -sS --max-time 20 -o /dev/null -w '' "$OTP_URL"; then
    echo "!! relay is not reachable through the tunnel" >&2
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
