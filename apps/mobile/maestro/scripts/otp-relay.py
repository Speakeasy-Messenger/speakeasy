#!/usr/bin/env python3
"""Relay the emailed Vouchflow fallback OTP to the device under test.

WHY THIS EXISTS
    `_email-fallback-otp.yaml` must type a code that does not exist until
    the device is already sitting on the code screen: Vouchflow mints it
    per run, mails it, and expires it after five minutes. So it cannot be
    baked into the flow zip before upload — the flow has to fetch it at
    the moment it needs it. This process is the thing it fetches from.

    Vouchflow sends through Resend, so the code is readable from the
    sending account: list recent emails, keep the ones addressed to the
    run's inbox that were created after the run started, and pull the
    six digits out of the body.

PACING IS THIS SERVER'S JOB, NOT THE FLOW'S
    Maestro's JS `http` client is built with a 10s read timeout
    (`maestro.utils.HttpClient` defaults) and Maestro has no reliable
    sleep primitive, so the flow cannot pace its own polling. Instead
    each GET here BLOCKS for up to WAIT_SECONDS waiting for a code before
    answering empty. The flow's `repeat` loop therefore ticks at exactly
    that interval with no client-side timer, and stays well inside the
    read timeout.

RESPONSE CONTRACT (kept trivial so the flow-side JS stays a one-liner)
    GET /<token>/otp -> 200 text/plain, body is either the six digits or
    empty. Any other path -> 404. Nothing is ever written to disk.

Env:
    RESEND_API_KEY  - the Vouchflow sending account's key. Required.
    FALLBACK_EMAIL  - inbox the run's code is addressed to. Required.
    OTP_RELAY_PORT  - port to listen on (default 8787).
    OTP_RELAY_TOKEN - path segment guarding the endpoint. Required.
    OTP_SINCE       - ISO-8601 UTC; ignore mail older than this. Required.
"""

import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

RESEND_API = "https://api.resend.com"
POLL_SECONDS = 3.0
WAIT_SECONDS = 5.0
# Bodies are scanned for a standalone six-digit run. `\b` alone would also
# match the tail of a longer number, which is why the neighbours are
# explicitly non-digits.
CODE_RE = re.compile(r"(?<!\d)(\d{6})(?!\d)")
TAG_RE = re.compile(r"<[^>]+>")

KEY = os.environ.get("RESEND_API_KEY", "")
INBOX = os.environ.get("FALLBACK_EMAIL", "").strip().lower()
PORT = int(os.environ.get("OTP_RELAY_PORT", "8787"))
TOKEN = os.environ.get("OTP_RELAY_TOKEN", "")
SINCE_RAW = os.environ.get("OTP_SINCE", "")

for name, value in (
    ("RESEND_API_KEY", KEY),
    ("FALLBACK_EMAIL", INBOX),
    ("OTP_RELAY_TOKEN", TOKEN),
    ("OTP_SINCE", SINCE_RAW),
):
    if not value:
        sys.exit(f"otp-relay: {name} is required")

SINCE = datetime.fromisoformat(SINCE_RAW.replace("Z", "+00:00"))

_found = {"code": None}
_seen_ids: set[str] = set()


def log(msg: str) -> None:
    print(f"[otp-relay] {msg}", file=sys.stderr, flush=True)


def api(path: str):
    req = urllib.request.Request(
        RESEND_API + path, headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.load(res)


def created_at(email: dict):
    raw = email.get("created_at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def addressed_to_run(email: dict) -> bool:
    to = email.get("to") or []
    if isinstance(to, str):
        to = [to]
    return any(INBOX in str(addr).strip().lower() for addr in to)


def extract_code(detail: dict):
    """Pull the OTP out of one email, preferring the least noisy source."""
    text = detail.get("text") or ""
    html = detail.get("html") or ""
    subject = detail.get("subject") or ""
    # Subject first (a code there is unambiguous), then plain text, then
    # HTML with tags stripped so attribute numbers cannot be mistaken for
    # the code.
    for source in (subject, text, TAG_RE.sub(" ", html)):
        matches = CODE_RE.findall(source)
        if not matches:
            continue
        distinct = list(dict.fromkeys(matches))
        if len(distinct) == 1:
            return distinct[0]
        # More than one candidate: take the one that follows the word
        # "code", which is how Vouchflow's template reads.
        near = re.search(r"code[^0-9]{0,40}(?<!\d)(\d{6})(?!\d)", source, re.I)
        if near:
            return near.group(1)
        log(f"ambiguous six-digit runs {distinct}; skipping this source")
    return None


def poll_once() -> None:
    listing = api("/emails?limit=100")
    emails = listing.get("data") or []
    candidates = []
    for email in emails:
        eid = email.get("id")
        if not eid or eid in _seen_ids or not addressed_to_run(email):
            continue
        stamp = created_at(email)
        if stamp is None or stamp < SINCE:
            continue
        candidates.append((stamp, eid))
    # Newest first: the run's own code, not an earlier attempt's.
    candidates.sort(reverse=True)
    for stamp, eid in candidates:
        _seen_ids.add(eid)
        code = extract_code(api(f"/emails/{eid}"))
        if code:
            log(f"code found in email {eid} sent {stamp.isoformat()}")
            _found["code"] = code
            return


def poller() -> None:
    while _found["code"] is None:
        try:
            poll_once()
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as err:
            # Transient: the flow keeps polling us, so one bad Resend
            # response must not end the watch.
            log(f"poll failed ({err}); retrying")
        if _found["code"] is None:
            time.sleep(POLL_SECONDS)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self.path != f"/{TOKEN}/otp":
            self.send_error(404)
            return
        # Block here rather than answering empty immediately: this is what
        # paces the flow's repeat loop.
        deadline = time.monotonic() + WAIT_SECONDS
        while _found["code"] is None and time.monotonic() < deadline:
            time.sleep(0.25)
        body = (_found["code"] or "").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        """Silence per-request logging; the code itself must never be logged."""


def main() -> None:
    threading.Thread(target=poller, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on 127.0.0.1:{PORT}, watching {INBOX} since {SINCE.isoformat()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
