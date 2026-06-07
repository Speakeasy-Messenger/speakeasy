# Store screenshot decorator

Turns plain in-app captures into branded Play Store heroes — a value-prop
headline (BONE/BRASS two-tone, Bricolage Grotesque, the app's own font) over
a framed phone on a warm INK gradient. Output is 1080×1920 (9:16, under
Play's 2:1 aspect cap; raw 1080×2340 captures exceed it).

## Layout

- Raw captures live in `images/phoneScreenshots-source/` (drop new ones here).
- Decorated output overwrites `images/phoneScreenshots/` — what Play uploads.

## Regenerate

    pip install pillow numpy
    python3 fastlane/screenshot-decorator/decorate.py

## Re-caption

Edit the `SHOTS` list in `decorate.py` (per-screenshot, per-word colour),
re-run, then push the listing:

    gh workflow run play-listing.yml -f language=en-US

`play-listing.yml` clears the existing screenshot set and re-uploads
everything in `phoneScreenshots/` in filename order.
