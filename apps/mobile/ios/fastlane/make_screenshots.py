#!/usr/bin/env python3
"""
Generate App Store screenshots (iPhone 6.9" — 1320x2868) for Speakeasy.

iOS analog of the Android Play marketing screenshots
(fastlane/metadata/android/en-US/images/phoneScreenshots). Mirrors the
same six scenes + captions, reframed for iOS: an iPhone shell (Dynamic
Island + iOS status bar) on the brand aubergine gradient, with the brass
highlight caption.

Source app captures come from the Android RN build — the React Native UI
renders pixel-identically across platforms; only the OS chrome (status bar
/ nav bar) is cropped and replaced with iOS chrome. Run from apps/mobile/ios:

    python3 fastlane/make_screenshots.py

Output: fastlane/screenshots/en-US/<n>_<scene>.png (consumed by
`fastlane deliver` / listing-ios.yml).
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
SRC = os.path.join(REPO, "fastlane/metadata/android/en-US/images/phoneScreenshots-source")
OUT = os.path.join(HERE, "screenshots", "en-US")
FONTS = os.path.join(REPO, "apps/mobile/android/app/src/main/assets/fonts")
os.makedirs(OUT, exist_ok=True)

# ---- Brand palette (apps/mobile/src/theme/tokens.ts) ----
BONE = (242, 233, 216)            # text
BRASS = (229, 166, 69)            # accent.base #E5A645
GRAD_TOP = (44, 26, 52)           # lifted aubergine
GRAD_BOT = (16, 9, 22)            # near brand.canvas #14091A

W, H = 1320, 2868                 # iPhone 16 Pro Max portrait — App Store 6.9"

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

XB = "BricolageGrotesque-ExtraBold.ttf"
SB = "BricolageGrotesque-SemiBold.ttf"
MD = "BricolageGrotesque-Medium.ttf"

# scene file, then caption as list of lines; each line = list of (text,color)
SCENES = [
    ("1_door.png", "1_door", [
        [("No phone number.", BONE)],
        [("No ", BONE), ("real name.", BRASS)],
    ]),
    ("2_avatar-picker.jpg", "2_avatar-picker", [
        [("Pick a face.", BONE)],
        [("Stay ", BONE), ("anonymous.", BRASS)],
    ]),
    ("3_private-call-connected.jpg", "3_private-call-connected", [
        [("Calls that ", BONE), ("mask", BRASS)],
        [("your voice.", BONE)],
    ]),
    ("4_group-chat.jpg", "4_group-chat", [
        [("Rooms that ", BONE), ("vanish", BRASS)],
        [("in 24 hours.", BONE)],
    ]),
    ("5_your-handle-qr.jpg", "5_your-handle-qr", [
        [("Share a ", BONE), ("handle.", BRASS)],
        [("Not your number.", BONE)],
    ]),
    ("6_private-call-ringing.jpg", "6_private-call-ringing", [
        [("End-to-end", BRASS)],
        [("encrypted calls.", BONE)],
    ]),
]


def gradient_bg():
    bg = Image.new("RGB", (W, H), GRAD_BOT)
    px = bg.load()
    for y in range(H):
        t = y / (H - 1)
        # ease toward bottom so most of the canvas is deep aubergine
        t = t ** 0.85
        r = int(GRAD_TOP[0] + (GRAD_BOT[0] - GRAD_TOP[0]) * t)
        g = int(GRAD_TOP[1] + (GRAD_BOT[1] - GRAD_TOP[1]) * t)
        b = int(GRAD_TOP[2] + (GRAD_BOT[2] - GRAD_TOP[2]) * t)
        for x in range(W):
            px[x, y] = (r, g, b)
    # subtle brass radial glow behind the phone
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    cx, cy = W // 2, int(H * 0.52)
    for i, rad in enumerate(range(700, 0, -40)):
        gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=int(8 + i * 1.5))
    tint = Image.new("RGB", (W, H), BRASS)
    bg = Image.composite(Image.blend(bg, tint, 0.18), bg, glow)
    return bg


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def ios_statusbar(draw, sx, sy, sw, fg=BONE):
    """Draw an iOS-style status bar at the top of the screen area."""
    f = font(SB, 32)
    draw.text((sx + 50, sy + 24), "9:41", font=f, fill=fg)
    # right cluster: cellular bars, wifi, battery
    rx = sx + sw - 52
    # battery
    bw, bh = 46, 22
    by = sy + 28
    bx = rx - bw
    draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=6, outline=fg, width=3)
    draw.rounded_rectangle([bx + 4, by + 4, bx + bw - 6, by + bh - 4], radius=2, fill=fg)
    draw.rounded_rectangle([bx + bw + 1, by + 7, bx + bw + 5, by + bh - 7], radius=2, fill=fg)
    # wifi (simple arcs)
    wx = bx - 52
    for r in (18, 12, 6):
        draw.arc([wx - r, by - 2 + (16 - r), wx + r, by + 16 + (16 - r)], 210, 330, fill=fg, width=4)
    draw.ellipse([wx - 3, by + 14, wx + 3, by + 20], fill=fg)
    # cellular bars
    cxb = wx - 82
    for i in range(4):
        bhh = 7 + i * 6
        draw.rounded_rectangle([cxb + i * 13, by + 22 - bhh, cxb + i * 13 + 8, by + 22], radius=2, fill=fg)


def measure(line, fnt):
    return sum(fnt.getbbox(t)[2] - fnt.getbbox(t)[0] for t, _ in line)


def draw_caption(img, lines):
    d = ImageDraw.Draw(img)
    fsize = 104
    fnt = font(XB, fsize)
    # shrink to fit width
    while max(measure(l, fnt) for l in lines) > W - 150 and fsize > 60:
        fsize -= 4
        fnt = font(XB, fsize)
    asc, desc = fnt.getmetrics()
    lh = int((asc + desc) * 1.02)
    total = lh * len(lines)
    y = int(H * 0.052)
    for line in lines:
        lw = measure(line, fnt)
        x = (W - lw) // 2
        for text, color in line:
            d.text((x, y), text, font=fnt, fill=color)
            x += fnt.getbbox(text)[2] - fnt.getbbox(text)[0]
        y += lh


def build(scene_file, out_name, lines):
    img = gradient_bg()
    draw_caption(img, lines)

    # --- phone geometry: true iPhone 6.9" aspect, whole device visible ---
    phone_w = 824
    phone_h = round(phone_w * 2868 / 1320)     # 1791 — match device aspect
    frame_r = int(phone_w * 0.135)             # 111
    bezel = int(phone_w * 0.022)               # 18
    island_w, island_h = 236, 60
    phone_x = (W - phone_w) // 2
    phone_y = int(H * 0.198)

    # soft drop shadow beneath the phone
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [phone_x - 14, phone_y + 26, phone_x + phone_w + 14, phone_y + phone_h + 26],
        radius=frame_r + 14, fill=(0, 0, 0, 150))
    shadow = shadow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(26))
    img.paste(shadow, (0, 0), shadow)

    # outer titanium frame (near-black with a faint warm edge)
    frame = Image.new("RGBA", (phone_w, phone_h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    fd.rounded_rectangle([0, 0, phone_w - 1, phone_h - 1], radius=frame_r, fill=(24, 20, 28, 255))
    fd.rounded_rectangle([0, 0, phone_w - 1, phone_h - 1], radius=frame_r, outline=(64, 56, 70, 255), width=3)
    img.paste(frame, (phone_x, phone_y), frame)

    # --- screen area ---
    sx, sy = phone_x + bezel, phone_y + bezel
    sw, sh = phone_w - bezel * 2, phone_h - bezel * 2
    screen_r = frame_r - bezel

    # app capture: crop OS chrome (android status band top, nav bar bottom).
    # Some screens (the door) bake a *cream* status-band into the app itself —
    # detect leading bright rows and crop the whole band so the iOS status
    # strip samples the dark app canvas, not the cream.
    cap = Image.open(os.path.join(SRC, scene_file)).convert("RGB")
    cw, ch = cap.size
    gray = cap.convert("L")
    bright = 0
    for y in range(min(int(ch * 0.09), ch)):
        row = gray.crop((0, y, cw, y + 1)).resize((1, 1)).getpixel((0, 0))
        if row > 170:
            bright = y + 1
        else:
            break
    top_crop = max(int(ch * 0.05), bright + 6)
    cap = cap.crop((0, top_crop, cw, ch - int(ch * 0.052)))

    statusbar_h = 90
    app_area = sh - statusbar_h

    # scale capture to screen width, then crop/pad bottom to fill app area
    cap = cap.resize((sw, round(cap.height * sw / cap.width)))
    top_rgb = cap.crop((0, 0, cap.width, 8)).resize((1, 1)).getpixel((0, 0))
    if cap.height >= app_area:
        cap = cap.crop((0, 0, sw, app_area))
    else:
        pad = Image.new("RGB", (sw, app_area), top_rgb)  # extend dark canvas
        pad.paste(cap, (0, 0))
        cap = pad

    # compose screen: iOS status strip (app-canvas color) + app content
    screen = Image.new("RGB", (sw, sh), top_rgb)
    screen.paste(cap, (0, statusbar_h))
    sd = ImageDraw.Draw(screen)
    # contrast-aware status bar tint
    lum = 0.299 * top_rgb[0] + 0.587 * top_rgb[1] + 0.114 * top_rgb[2]
    fg = (20, 9, 26) if lum > 140 else BONE
    ios_statusbar(sd, 0, 0, sw, fg)
    # home indicator
    hi_w = int(sw * 0.34)
    sd.rounded_rectangle([(sw - hi_w) // 2, sh - 26, (sw + hi_w) // 2, sh - 17],
                         radius=5, fill=BONE)

    smask = rounded_mask((sw, sh), screen_r)
    img.paste(screen, (sx, sy), smask)

    # Dynamic Island
    d = ImageDraw.Draw(img)
    ix = sx + (sw - island_w) // 2
    iy = sy + 26
    d.rounded_rectangle([ix, iy, ix + island_w, iy + island_h], radius=island_h // 2, fill=(0, 0, 0))

    img.save(os.path.join(OUT, out_name + ".png"))
    return out_name


if __name__ == "__main__":
    for sf, name, lines in SCENES:
        print("built", build(sf, name, lines))
    print("->", OUT)
