#!/usr/bin/env python3
"""Tilt of Time — local server with caching disabled.

A plain `python3 -m http.server` lets the browser cache game.js/style.css, so
edits can appear "not to work" until a hard refresh. This server sends
no-cache headers and the right MIME type for .mjs, so every reload is fresh.
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quieter console at the stall


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    httpd = HTTPServer(("0.0.0.0", port), Handler)
    url = f"http://localhost:{port}"
    print("\n  🏮  Tilt of Time (offline build) is serving at:  " + url)
    print("      Open it in Chrome/Edge and allow camera access. Press F for fullscreen.")
    print("      Caching is disabled, so every reload is fresh.  (Ctrl+C to stop)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
