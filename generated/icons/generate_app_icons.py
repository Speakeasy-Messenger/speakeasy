from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "generated/icons/drafts/speakeasy-icon-draft-01.png"
FINAL = ROOT / "generated/icons/final"
MASTER = FINAL / "speakeasy-app-icon-master-1024.png"

BG_TOP = (10, 12, 22)
BG_BOTTOM = (17, 18, 30)


IOS_IMAGES = [
    ("iphone", "20x20", "2x", 40, "Icon-App-20x20@2x.png"),
    ("iphone", "20x20", "3x", 60, "Icon-App-20x20@3x.png"),
    ("iphone", "29x29", "2x", 58, "Icon-App-29x29@2x.png"),
    ("iphone", "29x29", "3x", 87, "Icon-App-29x29@3x.png"),
    ("iphone", "40x40", "2x", 80, "Icon-App-40x40@2x.png"),
    ("iphone", "40x40", "3x", 120, "Icon-App-40x40@3x.png"),
    ("iphone", "60x60", "2x", 120, "Icon-App-60x60@2x.png"),
    ("iphone", "60x60", "3x", 180, "Icon-App-60x60@3x.png"),
    ("ipad", "20x20", "1x", 20, "Icon-App-20x20@1x.png"),
    ("ipad", "20x20", "2x", 40, "Icon-App-20x20@2x-ipad.png"),
    ("ipad", "29x29", "1x", 29, "Icon-App-29x29@1x.png"),
    ("ipad", "29x29", "2x", 58, "Icon-App-29x29@2x-ipad.png"),
    ("ipad", "40x40", "1x", 40, "Icon-App-40x40@1x.png"),
    ("ipad", "40x40", "2x", 80, "Icon-App-40x40@2x-ipad.png"),
    ("ipad", "76x76", "1x", 76, "Icon-App-76x76@1x.png"),
    ("ipad", "76x76", "2x", 152, "Icon-App-76x76@2x.png"),
    ("ipad", "83.5x83.5", "2x", 167, "Icon-App-83.5x83.5@2x.png"),
    ("ios-marketing", "1024x1024", "1x", 1024, "Icon-App-1024x1024@1x.png"),
]

ANDROID_LEGACY = [
    ("mipmap-mdpi", 48),
    ("mipmap-hdpi", 72),
    ("mipmap-xhdpi", 96),
    ("mipmap-xxhdpi", 144),
    ("mipmap-xxxhdpi", 192),
]

ANDROID_ADAPTIVE = [
    ("mipmap-mdpi", 108),
    ("mipmap-hdpi", 162),
    ("mipmap-xhdpi", 216),
    ("mipmap-xxhdpi", 324),
    ("mipmap-xxxhdpi", 432),
]


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)


def square_resize(img: Image.Image, size: int) -> Image.Image:
    img = ImageOps.fit(img, (size, size), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    return img.convert("RGB")


def vertical_gradient(size: int) -> Image.Image:
    gradient = Image.new("RGB", (size, size))
    pix = gradient.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        row = tuple(round(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
        for x in range(size):
            pix[x, y] = row
    return gradient


def rounded_preview(img: Image.Image, size: int) -> Image.Image:
    icon = img.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.225), fill=255)
    icon.putalpha(mask)
    return icon


def make_foreground(master: Image.Image, size: int) -> Image.Image:
    rgba = master.convert("RGBA")
    r, g, b, _ = rgba.split()
    # The source mark is bright lavender on a near-black background; this creates
    # a clean transparent raster foreground without vector reconstruction.
    luminance = ImageOps.grayscale(rgba)
    alpha = luminance.point(lambda v: 0 if v < 32 else min(255, int((v - 32) * 3.2)))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.5))
    subject = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    subject.paste(rgba, (0, 0), alpha)
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError("Could not isolate icon foreground")

    cropped = subject.crop(bbox)
    target_w = round(size * 0.64)
    target_h = round(size * 0.54)
    scale = min(target_w / cropped.width, target_h / cropped.height)
    resized = cropped.resize((round(cropped.width * scale), round(cropped.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - resized.width) // 2
    y = (size - resized.height) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas


def make_adaptive_composite(master: Image.Image, size: int) -> Image.Image:
    composite = vertical_gradient(size).convert("RGBA")
    composite.alpha_composite(make_foreground(master, size), (0, 0))
    return composite.convert("RGB")


def make_android_legacy(master: Image.Image, size: int) -> Image.Image:
    icon = master.resize((size, size), Image.Resampling.LANCZOS).convert("RGB")
    return icon


def make_android_round(master: Image.Image, size: int) -> Image.Image:
    icon = master.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    inset = max(1, round(size * 0.02))
    draw.ellipse((inset, inset, size - inset - 1, size - inset - 1), fill=255)
    icon.putalpha(mask)
    return icon


def main() -> None:
    src = Image.open(SOURCE)
    master = square_resize(src, 1024)
    save_png(master, MASTER)

    ios_dir = FINAL / "ios/AppIcon.appiconset"
    contents = {"images": [], "info": {"author": "xcode", "version": 1}}
    for idiom, logical_size, scale, px, filename in IOS_IMAGES:
        save_png(master.resize((px, px), Image.Resampling.LANCZOS).convert("RGB"), ios_dir / filename)
        contents["images"].append(
            {
                "idiom": idiom,
                "size": logical_size,
                "scale": scale,
                "filename": filename,
            }
        )
    (ios_dir / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n", encoding="utf-8")

    android_root = FINAL / "android/app/src/main/res"
    for folder, px in ANDROID_LEGACY:
        out = android_root / folder
        save_png(make_android_legacy(master, px), out / "ic_launcher.png")
        save_png(make_android_round(master, px), out / "ic_launcher_round.png")

    for folder, px in ANDROID_ADAPTIVE:
        out = android_root / folder
        save_png(make_foreground(master, px), out / "ic_launcher_foreground.png")
        save_png(vertical_gradient(px), out / "ic_launcher_background.png")

    save_png(master, FINAL / "android/play-store-icon.png")
    save_png(rounded_preview(master, 1024), FINAL / "previews/speakeasy-icon-rounded-preview.png")
    save_png(make_foreground(master, 1024), FINAL / "previews/speakeasy-adaptive-foreground-preview.png")
    save_png(make_adaptive_composite(master, 1024), FINAL / "previews/speakeasy-adaptive-composite-preview.png")


if __name__ == "__main__":
    main()
