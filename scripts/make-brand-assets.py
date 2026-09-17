"""Bake Leftleg brand assets from the literal 🦿 (mechanical leg) emoji glyph.

Default source: Windows Segoe UI Emoji (COLRv0, rendered via Pillow) — the same
glyph the app's users see when they type the emoji. Fallback: Noto Color Emoji
PNG downloaded from the googlefonts/noto-emoji repo.

Outputs (same paths as the art-based bake, so no code changes needed):
  src-tauri/icons/app-icon.png  - 1024x1024 squircle master (transparent corners)
  src/assets/leftleg-mark.png   - transparent leg-only mark (title bar / in-app)

Usage:
  python scripts/make-brand-assets.py            # emoji, mirrored (default)
  python scripts/make-brand-assets.py --no-mirror
  python scripts/make-brand-assets.py --source noto
  python scripts/make-brand-assets.py --source art   # the earlier red flexed-leg art
"""
from __future__ import annotations

import sys
import urllib.request
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ART_SRC = ROOT / ".pi/images/20260915-183721-emoji-style-sticker-illustration-in-the-.png"
NOTO_URL = "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f9bf.png"
NOTO_CACHE = ROOT / ".pi/images/_emoji-u1f9bf-noto.png"
SEGOE_CANDIDATE = ROOT / ".pi/images/_emoji-u1f9bf-segoe.png"
EMOJI = "\U0001F9BF"  # 🦿

ICON_OUT = ROOT / "src-tauri/icons/app-icon.png"
MARK_OUT = ROOT / "src/assets/leftleg-mark.png"

WHITE_T = 235
SQUIRCLE_BG = (23, 23, 30, 255)  # #17171e


def border_connected_white(near_white: np.ndarray) -> np.ndarray:
    """White-ish pixels connected to the image border (true background)."""
    try:
        from scipy import ndimage

        lab, n = ndimage.label(near_white)
        border = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
        border_labels = {int(v) for v in np.unique(border) if v != 0}
        return np.isin(lab, sorted(border_labels)) if border_labels else np.zeros_like(near_white)
    except ImportError:
        h, w = near_white.shape
        bg = np.zeros_like(near_white)
        dq: deque[tuple[int, int]] = deque()
        for x in range(w):
            for y in (0, h - 1):
                if near_white[y, x] and not bg[y, x]:
                    bg[y, x] = True
                    dq.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if near_white[y, x] and not bg[y, x]:
                    bg[y, x] = True
                    dq.append((y, x))
        while dq:
            y, x = dq.popleft()
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and near_white[ny, nx] and not bg[ny, nx]:
                    bg[ny, nx] = True
                    dq.append((ny, nx))
        return bg


def key_white_bg(img: Image.Image) -> Image.Image:
    """Flood-key border-connected white to transparency, unpremultiplied."""
    arr = np.asarray(img.convert("RGBA")).astype(np.float64)
    rgb = arr[..., :3]
    near_white = np.all(rgb >= WHITE_T, axis=-1)
    bg = border_connected_white(near_white)
    alpha = np.where(bg, 0.0, 255.0)
    a_img = Image.fromarray(alpha.astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.75))
    a = np.asarray(a_img).astype(np.float64)
    s = a / 255.0
    fg = np.zeros_like(rgb)
    m = s > 0.004
    fg[m] = np.clip((rgb[m] - (1.0 - s[m, None]) * 255.0) / s[m, None], 0, 255)
    return Image.fromarray(np.dstack([fg, a[..., None]]).astype(np.uint8), "RGBA")


def render_segoe() -> Image.Image | None:
    """Render 🦿 with Windows Segoe UI Emoji (native Windows emoji look)."""
    font_path = Path(r"C:\Windows\Fonts\seguiemj.ttf")
    if not font_path.exists():
        return None
    canvas = Image.new("RGBA", (1400, 1400), (0, 0, 0, 0))
    try:
        font = ImageFont.truetype(str(font_path), 1024)
        ImageDraw.Draw(canvas).text(
            (700, 700), EMOJI, font=font, embedded_color=True, anchor="mm"
        )
    except Exception as exc:  # noqa: BLE001 - any font/COLR failure falls back
        print(f"  seguiemj render failed: {exc}")
        return None
    arr = np.asarray(canvas)
    ink = arr[..., 3] > 8
    cover = ink.mean()
    print(f"  seguiemj ink coverage: {cover:.3f}")
    if not (0.02 < cover < 0.75):  # nothing drawn / implausible flood
        return None
    canvas.save(SEGOE_CANDIDATE)
    return canvas


def render_noto() -> Image.Image:
    if not NOTO_CACHE.exists():
        print(f"  downloading Noto 🦿 from {NOTO_URL}")
        urllib.request.urlretrieve(NOTO_URL, NOTO_CACHE)  # noqa: S310
    return Image.open(NOTO_CACHE).convert("RGBA")


def load_emoji(source: str) -> Image.Image:
    if source == "noto":
        return render_noto()
    if source == "art":
        return Image.open(ART_SRC).convert("RGBA")
    img = render_segoe()
    if img is None:
        print("  falling back to Noto emoji")
        img = render_noto()
    return img


def ink_bbox(img: Image.Image, alpha_min: int = 8, pad: int = 12) -> Image.Image:
    a = np.asarray(img)[..., 3]
    ys, xs = np.where(a >= alpha_min)
    if len(ys) == 0:
        raise SystemExit("emoji rendered empty")
    h, w = a.shape
    return img.crop((max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
                     min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad)))


def main() -> None:
    argv = sys.argv[1:]
    mirror = "--no-mirror" not in argv
    source = "art" if "--source" in argv and "art" in argv else (
        "noto" if "--source" in argv and "noto" in argv else "emoji")
    if source == "art":
        print("source: red flexed-leg art (.pi render)")
        img = ART_SRC
        keyed = key_white_bg(img)
        if mirror:
            keyed = keyed.transpose(Image.FLIP_LEFT_RIGHT)
        leg_img = keyed  # art mode keeps steam/streaks for the icon master
    else:
        print(f"source: {'emoji ' + EMOJI} ({'Segoe' if source == 'emoji' else 'Noto'})")
        raw = load_emoji(source)
        keyed = raw  # emoji PNGs/fonts are already transparent
        if mirror:
            keyed = keyed.transpose(Image.FLIP_LEFT_RIGHT)
        leg_img = keyed

    # --- title bar mark: tight ink crop, 256px tall ---
    mark = ink_bbox(leg_img)
    scale = 256 / mark.height
    mark = mark.resize((max(1, round(mark.width * scale)), 256), Image.LANCZOS)
    MARK_OUT.parent.mkdir(parents=True, exist_ok=True)
    mark.save(MARK_OUT)

    # --- squircle master: ink crop centered on dark squircle ---
    S = 1024
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=SQUIRCLE_BG)
    art = ink_bbox(leg_img)
    fit = int(S * 0.66)
    sc = min(fit / art.width, fit / art.height)
    art = art.resize((max(1, round(art.width * sc)), max(1, round(art.height * sc))), Image.LANCZOS)
    canvas.alpha_composite(art, ((S - art.width) // 2, (S - art.height) // 2))
    ICON_OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(ICON_OUT)

    print(f"wrote {ICON_OUT.relative_to(ROOT)}")
    print(f"wrote {MARK_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
