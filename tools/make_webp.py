#!/usr/bin/env python3
"""Encode the demo's model textures as WebP siblings so the browser downloads
megabytes instead of tens of megabytes - and at display resolution instead of the
art's full 8192px, which is what actually makes the page start up fast.

Everything it needs is read from models/manifest.js: each `model3:` path (and each
companion model3 it finds in the same tree) is parsed for FileReferences.Textures,
and every PNG there gets a .webp next to it. The originals stay untouched, so
live2d/loadModel.js can fall back to PNG for any model that was never converted.

    python tools/make_webp.py            # convert anything missing or stale
    python tools/make_webp.py --force    # re-encode everything
    python tools/make_webp.py --check    # list what would change, write nothing
    python tools/make_webp.py --max 0    # keep full resolution

Decoding and uploading an 8192px atlas costs ~67 megapixels per texture, and the
character is only ~600 pixels tall on screen: that single step was most of the
4-second load. Textures are halved down to --max so the dimension stays a power of
two (WebGL1 mipmap generation needs that), which keeps her sharp at any normal
window and cuts the work by an order of magnitude.

Quality 90 with chroma subsampling disabled: the art is hard-edged with alpha
(lashes, hair tips, eye shine), and 4:2:0 bleeds colour into those edges.
"""

import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "models", "manifest.js")

QUALITY = 90
METHOD = 4          # encoder search effort: 4 is a good size/time trade-off
SUBSAMPLING = 3     # 4:0:0 = no chroma subsampling
MAX_EDGE = 2048     # longest texture edge worth displaying at a normal window size


def pot_halve(size, max_edge):
    """Halve both dimensions until the longest edge fits, keeping power-of-two."""
    w, h = size
    while max(w, h) > max_edge > 0:
        w //= 2
        h //= 2
    return w, h


def model3_paths():
    """Every model3.json the manifest references, host and companion alike."""
    with open(MANIFEST, encoding="utf-8") as f:
        src = f.read()
    out = []
    for rel in re.findall(r"model3:\s*'([^']+)'", src):
        p = os.path.normpath(os.path.join(ROOT, rel.replace("./", "")))
        if p not in out:
            out.append(p)
    return out


def textures_of(model3):
    """Texture file names declared by a model3.json, resolved against its folder."""
    with open(model3, encoding="utf-8") as f:
        data = json.load(f)
    base = os.path.dirname(model3)
    refs = data.get("FileReferences", {})
    files = refs.get("Textures") or []
    if isinstance(files, str):
        files = [files]
    return [os.path.normpath(os.path.join(base, t)) for t in files]


def needs_encode(png, webp, force):
    if force:
        return True
    if not os.path.exists(webp):
        return True
    return os.path.getmtime(webp) < os.path.getmtime(png)


def main():
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is required:  pip install pillow")
    Image.MAX_IMAGE_PIXELS = None      # 8192x8192 atlases are expected

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="re-encode even if up to date")
    ap.add_argument("--check", action="store_true", help="report only")
    ap.add_argument("--max", type=int, default=MAX_EDGE,
                    help="longest texture edge to encode, halved to stay power-of-two "
                         "(0 keeps full resolution; re-run with --force after changing it)")
    args = ap.parse_args()

    todo, seen = [], set()
    for model3 in model3_paths():
        if not os.path.exists(model3):
            print("!! missing model3:", os.path.relpath(model3, ROOT))
            continue
        for png in textures_of(model3):
            if png in seen or not png.lower().endswith((".png", ".jpg", ".jpeg")):
                continue
            seen.add(png)
            if not os.path.exists(png):
                print("!! missing texture:", os.path.relpath(png, ROOT))
                continue
            todo.append((png, os.path.splitext(png)[0] + ".webp"))

    work = [(p, w) for p, w in todo if needs_encode(p, w, args.force)]
    if args.check:
        for p, w in work:
            print("would encode", os.path.relpath(p, ROOT))
        print("%d of %d textures need encoding" % (len(work), len(todo)))
        return

    saved = 0.0
    for png, webp in work:
        im = Image.open(png).convert("RGBA")
        original = (im.width, im.height)
        w, h = pot_halve(original, args.max)
        if (w, h) != original:
            im = im.resize((w, h), Image.LANCZOS)
        im.save(webp, "WEBP", quality=QUALITY, method=METHOD, subsampling=SUBSAMPLING)
        before, after = os.path.getsize(png), os.path.getsize(webp)
        saved += before - after
        shrink = "" if (w, h) == original else "  (%dx%d ->)" % original
        print("%-58s %6.1f MB -> %5.1f MB  %dx%d%s"
              % (os.path.relpath(png, ROOT), before / 1e6, after / 1e6, w, h, shrink))
    print("done: %d encoded, %.1f MB smaller on disk" % (len(work), saved / 1e6))


if __name__ == "__main__":
    main()
