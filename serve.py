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
"""

import argparse
import errno
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


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
