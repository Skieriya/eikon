#!/usr/bin/env python3
"""Local static server for the Live2D demo.

    python serve.py                  # http://127.0.0.1:8000/
    python serve.py --port 8080

`python -m http.server` works but is slow for a page like this one, and the
difference is seconds of perceived load:

* it speaks HTTP/1.0, so every one of the ~60 requests re-opens a socket;
* it is single-threaded, so a big texture blocks everyone behind it;
* it sends no Cache-Control, so a reload behaves inconsistently across file types.

This keeps the same stdlib handler and fixes all three: HTTP/1.1 with keep-alive, a
thread per connection, and revalidation for every file.

Revalidation rather than long-lived caching is deliberate: tools/make_webp.py rewrites
the textures under the same URL, and `immutable` would pin the old bytes in every
browser that had ever loaded the page - the new, smaller files would look like they
made no difference. A 304 over a keep-alive connection costs about a millisecond.

One write endpoint, for recorder.html:

    POST /recordings   {"model3": "models/hu_tao/Hu Tao.model3.json",
                        "name": "wave", "motion": { ...motion3.json... }}

It validates the model path, the clip name and the JSON shape, then writes
<model folder>/motions/recorded/<name>.motion3.json and regenerates
<model folder>/recorded.json from whatever is on disk. Nothing else is writable, and
this stays a dev server - it binds to 127.0.0.1 by default.
"""

import argparse
import errno
import json
import os
import re
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 8 * 1024 * 1024
# Lowercase, digits, _ and -; starts with a letter or digit; short enough to type.
CLIP_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"        # keep-alive: one socket for the whole page
    # A dead client must not hang its worker thread forever.
    timeout = 30
    # Windows resolves .webp from the registry and often answers
    # application/octet-stream, which createImageBitmap refuses to decode - the
    # blob's MIME type is what tells it the bytes are an image.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webp": "image/webp",
        ".moc3": "application/octet-stream",
    }

    def end_headers(self):
        # Always ask the server whether the file changed; a 304 carries no body.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.server.verbose:
            return
        super().log_message(fmt, *args)

    # ---- recorder.html saves -------------------------------------------------

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/recordings":
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                raise ValueError("body must be between 1 and %d bytes" % MAX_BODY)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            file, path, clips = self._write_take(payload)
        except Exception as e:                      # never leak a traceback to the page
            return self._json(400, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        return self._json(200, {"ok": True, "file": file, "path": path, "clips": clips})

    def _write_take(self, payload):
        model3 = str(payload.get("model3") or "")
        parts = model3.split("/")
        if not model3.startswith("models/") or ".." in parts or not model3.endswith(".model3.json"):
            raise ValueError("model3 must be a models/<folder>/<name>.model3.json path")
        model_path = os.path.join(self.directory, *parts)
        if not os.path.isfile(model_path):
            raise ValueError("no such model: " + model3)
        folder = os.path.dirname(model_path)

        name = str(payload.get("name") or "").strip().lower().replace(" ", "_")
        name = re.sub(r"[^a-z0-9_-]", "", name)
        if not CLIP_NAME.match(name):
            raise ValueError("clip name must be lowercase letters, digits, _ or -")

        motion = payload.get("motion")
        meta = motion.get("Meta") if isinstance(motion, dict) else None
        if not isinstance(motion, dict) or motion.get("Version") != 3 or not isinstance(motion.get("Curves"), list) or not motion["Curves"]:
            raise ValueError("motion must be a .motion3.json object with Version 3 and Curves")
        # Duration is what every player and this demo's clip list reads; a clip
        # without a Meta is not a clip.
        if not isinstance(meta, dict) or not isinstance(meta.get("Duration"), (int, float)):
            raise ValueError("motion.Meta.Duration is missing")
        for curve in motion["Curves"]:
            segs = curve.get("Segments") if isinstance(curve, dict) else None
            if not isinstance(curve, dict) or curve.get("Target") != "Parameter" or not isinstance(curve.get("Id"), str):
                raise ValueError("every curve needs Target 'Parameter' and an Id")
            if not isinstance(segs, list) or len(segs) < 5 or not all(isinstance(v, (int, float)) for v in segs):
                raise ValueError("curve %s needs a numeric Segments array" % curve["Id"])
        if isinstance(motion.get("Meta"), dict):
            motion["Meta"]["Loop"] = bool(payload.get("loop"))

        outdir = os.path.join(folder, "motions", "recorded")
        os.makedirs(outdir, exist_ok=True)
        filename = name + ".motion3.json"
        with open(os.path.join(outdir, filename), "w", encoding="utf-8") as f:
            json.dump(motion, f)

        clips = self._scan_clips(folder, outdir)
        index = {
            "note": "Written by recorder.html. Clips are ordinary .motion3.json files; "
                    "each `file` is relative to this folder, like a model3.json path.",
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "clips": clips,
        }
        with open(os.path.join(folder, "recorded.json"), "w", encoding="utf-8") as f:
            json.dump(index, f, indent=1)
        # `file` follows the same rule as model3.json and recorded.json - relative to
        # the model folder - so the page keys the clip list and the file it just wrote
        # with the same string. `path` is the server-relative one, for humans.
        rel = os.path.join(outdir, filename)
        return (os.path.relpath(rel, folder).replace(os.sep, "/"),
                os.path.relpath(rel, self.directory).replace(os.sep, "/"), clips)

    def _scan_clips(self, folder, outdir):
        clips = []
        for filename in sorted(os.listdir(outdir)):
            if not filename.endswith(".motion3.json"):
                continue
            meta = {}
            try:
                with open(os.path.join(outdir, filename), encoding="utf-8") as f:
                    meta = json.load(f).get("Meta") or {}
            except (OSError, ValueError):
                pass    # a half-written file still belongs in the list
            clips.append({
                "name": filename[: -len(".motion3.json")],
                "file": os.path.relpath(os.path.join(outdir, filename), folder).replace(os.sep, "/"),
                "duration": meta.get("Duration"),
                "fps": meta.get("Fps"),
                "curves": meta.get("CurveCount"),
                "loop": bool(meta.get("Loop")),
            })
        return clips

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True                 # never wait on a stuck client at exit
    allow_reuse_address = True

    def __init__(self, addr, handler, verbose=False):
        super().__init__(addr, handler)
        self.verbose = verbose


def main():
    ap = argparse.ArgumentParser(description="Serve the Live2D demo over HTTP.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("-v", "--verbose", action="store_true", help="log every request")
    args = ap.parse_args()

    directory = os.path.abspath(args.dir)
    if not os.path.exists(os.path.join(directory, "index.html")):
        sys.exit("index.html not found in " + directory)

    handler = partial(Handler, directory=directory)
    try:
        httpd = Server((args.bind, args.port), handler, args.verbose)
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            sys.exit("port %d is already serving - open http://%s:%d/ instead of starting a second server"
                     % (args.port, args.bind, args.port))
        raise

    print("Serving %s at http://%s:%d/  (HTTP/1.1 keep-alive, %s)"
          % (directory, args.bind, args.port, "logging every request" if args.verbose else "everything revalidated"))
    print("Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        threading.Thread(target=httpd.server_close).start()


if __name__ == "__main__":
    main()
