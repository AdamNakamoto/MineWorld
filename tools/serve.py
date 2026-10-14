"""Serves web/ for local development like `python3 -m http.server`, but tells the browser never to cache, so an
edited module shows up on the next reload. Usage: python3 tools/serve.py <port> <directory>"""
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


port, directory = int(sys.argv[1]), sys.argv[2]
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(NoCache, directory=directory)).serve_forever()
