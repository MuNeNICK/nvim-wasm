#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import pathlib
import functools


class COOPHandler(SimpleHTTPRequestHandler):
  def end_headers(self):
    self.send_header("Cross-Origin-Opener-Policy", "same-origin")
    self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
    super().end_headers()


if __name__ == "__main__":
  root = pathlib.Path(__file__).parent / "public"
  print(f"Serving {root} on http://localhost:8765 with COOP/COEP headers")
  handler = functools.partial(COOPHandler, directory=str(root))
  server = ThreadingHTTPServer(("", 8765), handler)
  server.serve_forever()
