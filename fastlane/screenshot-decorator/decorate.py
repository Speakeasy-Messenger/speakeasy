#!/usr/bin/env python3
"""Decorate raw Play screenshots with value-prop headlines + a device frame.

Turns the plain in-app captures under
  fastlane/metadata/android/en-US/images/phoneScreenshots-source/
into branded store heroes written to
  fastlane/metadata/android/en-US/images/phoneScreenshots/

Brand: INK background, BONE/BRASS two-tone headlines set in the app's own
Bricolage Grotesque ExtraBold. Canvas 1080x1920 (9:16, ratio 1.78 — under
Play's 2:1 cap; the raw 1080x2340 captures exceed it). The phone floats on a
warm gradient with a soft brass glow and its bottom bleeds off-canvas.

Requirements: Pillow, numpy.
Run from anywhere:  python3 fastlane/screenshot-decorator/decorate.py
To re-caption: edit SHOTS below, re-run, then trigger play-listing.yml.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
IMG = os.path.join(REPO, "fastlane/metadata/android/en-US/images")
SRC = os.path.join(IMG, "phoneScreenshots-source")
OUT = os.path.join(IMG, "phoneScreenshots")
FONT = os.path.join(REPO, "apps/mobile/android/app/src/main/assets/fonts/BricolageGrotesque-ExtraBold.ttf")

INK, BONE, BRASS = (20, 9, 26), (242, 233, 216), (229, 166, 69)
W, H = 1080, 1920

# (source filename, output basename, [line1_segments, line2_segments])
# seg = (text, color)
SHOTS = [
    ("1_door.png", "1_door", [
        [("No phone number.", BONE)],
        [("No ", BONE), ("real name", BRASS), (".", BONE)]]),
    ("2_avatar-picker.jpg", "2_avatar-picker", [
        [("Pick a face.", BONE)],
        [("Stay ", BONE), ("anonymous", BRASS), (".", BONE)]]),
    ("3_private-call-connected.jpg", "3_private-call-connected", [
        [("Calls that ", BONE), ("mask", BRASS)],
        [("your voice.", BONE)]]),
    ("4_group-chat.jpg", "4_group-chat", [
        [("Rooms that ", BONE), ("vanish", BRASS)],
        [("in 24 hours.", BONE)]]),
    ("5_your-handle-qr.jpg", "5_your-handle-qr", [
        [("Share a ", BONE), ("handle", BRASS), (".", BONE)],
        [("Not your number.", BONE)]]),
    ("6_private-call-ringing.jpg", "6_private-call-ringing", [
        [("End-to-end", BRASS)],
        [("encrypted calls.", BONE)]]),
]


def vgrad(top, bot):
    base = Image.new("RGB", (W, H))
    px = base.load()
    for y in range(H):
        te = (y / (H - 1)) ** 1.15
        px_row = tuple(int(top[i] + (bot[i] - top[i]) * te) for i in range(3))
        for x in range(W):
            px[x, y] = px_row
    return base


def radial_glow(cx, cy, radius, color, max_alpha):
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    steps = 60
    for i in range(steps, 0, -1):
        rr = radius * i / steps
        d.ellipse([cx - rr, cy - rr * 1.15, cx + rr, cy + rr * 1.15],
                  fill=int(max_alpha * (1 - i / steps)))
    layer = layer.filter(ImageFilter.GaussianBlur(60))
    glow = Image.new("RGB", (W, H), color)
    out = Image.new("RGB", (W, H), (0, 0, 0))
    out.paste(glow, (0, 0), layer)
    return out


def add(a, b):
    return Image.fromarray(np.clip(np.asarray(a.convert("RGB")).astype(int)
                                   + np.asarray(b).astype(int), 0, 255).astype("uint8"))


def measure(draw, segs, font):
    return sum(draw.textlength(t, font=font) for t, _ in segs)


def fit_font(draw, lines, max_w, start=96, min_sz=52):
    sz = start
    while sz > min_sz:
        f = ImageFont.truetype(FONT, sz)
        if all(measure(draw, ln, f) <= max_w for ln in lines):
            return f
        sz -= 2
    return ImageFont.truetype(FONT, min_sz)


def draw_headline(img, lines):
    d = ImageDraw.Draw(img)
    font = fit_font(d, lines, W - 220)
    asc, desc = font.getmetrics()
    lh = asc + desc
    gap = int(lh * 0.10)
    y = 150
    for ln in lines:
        x = (W - measure(d, ln, font)) / 2
        for text, col in ln:
            d.text((x, y), text, font=font, fill=col)
            x += d.textlength(text, font=font)
        y += lh + gap


def device(shot_path, screen_w=648):
    bezel, r_out, r_in = 16, 70, 52
    sw = screen_w
    sh = int(round(sw * 2340 / 1080))
    dw, dh = sw + bezel * 2, sh + bezel * 2

    src = Image.open(shot_path).convert("RGB")
    rs = src.resize((sw, int(round(src.height * sw / src.width))), Image.LANCZOS)
    top = max(0, (rs.height - sh) // 2)
    screen = rs.crop((0, top, sw, top + sh))
    smask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(smask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=r_in, fill=255)

    dev = Image.new("RGBA", (dw, dh), (0, 0, 0, 0))
    ImageDraw.Draw(dev).rounded_rectangle([0, 0, dw - 1, dh - 1], radius=r_out, fill=(8, 4, 14, 255))
    ImageDraw.Draw(dev).rounded_rectangle([1, 1, dw - 2, dh - 2], radius=r_out,
                                          outline=(229, 166, 69, 90), width=3)
    dev.paste(screen, (bezel, bezel), smask)
    return dev


def main():
    for src_name, out_base, lines in SHOTS:
        canvas = add(vgrad((40, 23, 44), (9, 4, 15)),
                     radial_glow(W // 2, 1230, 560, (150, 95, 30), 120)).convert("RGBA")
        draw_headline(canvas, lines)

        dev = device(os.path.join(SRC, src_name))
        dx, dy = (W - dev.width) // 2, 600
        sh_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shadow = Image.new("RGBA", dev.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([0, 0, dev.width - 1, dev.height - 1],
                                                 radius=70, fill=(0, 0, 0, 160))
        sh_layer.alpha_composite(shadow, (dx, dy + 26))
        sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(40))
        canvas = Image.alpha_composite(canvas, sh_layer)
        canvas.alpha_composite(dev, (dx, dy))

        canvas.convert("RGB").save(os.path.join(OUT, out_base + ".png"))
        print("wrote", out_base + ".png")


if __name__ == "__main__":
    main()
