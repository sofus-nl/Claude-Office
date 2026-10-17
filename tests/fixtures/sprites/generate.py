"""
Regenerates the sprite-tools fixtures: the input PNGs here, and expected/ by
running the ORIGINAL Pillow scripts (scripts/split-character.py and
scripts/extract-boss-sprite.py) on them. Those were replaced by the .mjs
ports; restore them for a run with
    git show 1a9ba71:scripts/split-character.py > scripts/split-character.py
    git show 1a9ba71:scripts/extract-boss-sprite.py > scripts/extract-boss-sprite.py
and delete them again afterwards.

    python tests/fixtures/sprites/generate.py       (needs Pillow 11.x)

expected/split/<fixture>-1-<direction>.png   from split-character.py
expected/extract/<fixture>-<direction>.png   from extract-boss-sprite.py
"""

import os, shutil, struct, subprocess, sys, tempfile, zlib
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
W, H = 16, 12
BG = (9, 8, 7)


def opaque(x, y):
    # Margins so trimming has work to do; the bottom-right quadrant and the
    # last extract column are empty so the all-transparent path runs too.
    return 1 <= x <= 14 and 1 <= y <= 10 and (x * 5 + y * 3) % 7 < 3


def colour(x, y):
    return (40 + x * 11, 60 + y * 13, 90 + (x * y) % 100)


def pixels(empty_corner=False):
    for y in range(H):
        for x in range(W):
            yield x, y, opaque(x, y) and not (empty_corner and x >= 8 and y >= 6)


def build():
    out = {}
    img = Image.new("L", (W, H), BG[0])
    for x, y, on in pixels():
        if on: img.putpixel((x, y), 40 + (x * 7 + y) % 200)
    out["gray8-trns"] = (img, dict(transparency=BG[0]))

    img = Image.new("RGB", (W, H), BG)
    for x, y, on in pixels():
        if on: img.putpixel((x, y), colour(x, y))
    out["rgb8-trns"] = (img, dict(transparency=BG))
    out["rgb8"] = (img, {})

    for name, n, bits in (("pal8-trns", 200, 8), ("pal4-trns", 12, 4), ("pal2-trns", 4, 2)):
        img = Image.new("P", (W, H), 0)
        img.putpalette([c for i in range(n) for c in ((9, 8, 7) if i == 0 else (i * 20 % 256, 255 - i * 9 % 256, i * 37 % 256))])
        for x, y, on in pixels():
            if on: img.putpixel((x, y), 1 + (x + y) % (n - 1))
        out[name] = (img, dict(transparency=bytes([0, 128, 7]), bits=bits))

    img = Image.new("LA", (W, H), (BG[0], 0))
    for x, y, on in pixels():
        if on: img.putpixel((x, y), (40 + (x * 7 + y) % 200, 255 if (x + y) % 3 else 100))
    out["la8"] = (img, {})

    img = Image.new("RGBA", (W, H), BG + (0,))
    for x, y, on in pixels(empty_corner=True):
        if on: img.putpixel((x, y), colour(x, y) + (255 if (x + y) % 3 else 77,))
    out["rgba8"] = (img, {})

    img = Image.new("I;16", (W, H), 0)
    out["gray16-reject"] = (img, {})
    return out


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))


def raw_png(width, height, depth, ctype, rows, interlace=0):
    ihdr = struct.pack(">IIBBBBB", width, height, depth, ctype, 0, 0, interlace)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def all_filters_png():
    """RGBA8 with filter types 0..4 cycling per row, so every unfilter path is exercised."""
    img = Image.new("RGBA", (W, H), BG + (0,))
    for x, y, on in pixels():
        if on: img.putpixel((x, y), colour(x, y) + (255,))
    stride, bpp, data, prev, rows = W * 4, 4, img.tobytes(), bytes(W * 4), b""
    for y in range(H):
        cur, f = data[y * stride:(y + 1) * stride], y % 5
        enc = bytearray()
        for i, v in enumerate(cur):
            a = cur[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            pred = (0, a, b, (a + b) >> 1, paeth(a, b, c))[f]
            enc.append((v - pred) & 255)
        rows += bytes([f]) + bytes(enc)
        prev = cur
    return raw_png(W, H, 8, 6, rows)


def main():
    fixtures = {}
    for name, (img, kw) in build().items():
        path = HERE / f"{name}.png"
        img.save(path, **kw)
        fixtures[name] = path
    (HERE / "filters-all.png").write_bytes(all_filters_png())
    fixtures["filters-all"] = HERE / "filters-all.png"
    # 4-bit greyscale and interlaced: only ever rejected, so the pixel data is a stub.
    (HERE / "gray4-reject.png").write_bytes(raw_png(W, H, 4, 0, b"".join(b"\0" + bytes(W // 2) for _ in range(H))))
    (HERE / "interlaced-reject.png").write_bytes(raw_png(W, H, 8, 2, b"\0" * (H * (W * 3 + 1)), interlace=1))

    rejected = lambda n: n.endswith("-reject")
    exp = HERE / "expected"
    shutil.rmtree(exp, ignore_errors=True)
    (exp / "split").mkdir(parents=True)
    (exp / "extract").mkdir()
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        # extract-boss-sprite.py writes next to its own location, so run a copy.
        shutil.copytree(ROOT / "scripts", Path(tmp) / "scripts", ignore=shutil.ignore_patterns("*"))
        shutil.copy(ROOT / "scripts" / "extract-boss-sprite.py", Path(tmp) / "scripts")
        for name, path in fixtures.items():
            if rejected(name): continue
            subprocess.run([sys.executable, ROOT / "scripts" / "split-character.py", path, name, "--output-dir", exp / "split"], check=True, env=env, stdout=subprocess.DEVNULL)
            subprocess.run([sys.executable, Path(tmp) / "scripts" / "extract-boss-sprite.py", path, name], check=True, env=env, stdout=subprocess.DEVNULL)
        for f in (Path(tmp) / "public" / "sprites" / "characters").glob("*.png"):
            shutil.copy(f, exp / "extract" / f.name)


main()
