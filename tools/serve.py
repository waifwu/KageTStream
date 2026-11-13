#!/usr/bin/env python3
"""Serve the game for playing locally.

    python3 tools/serve.py [port, default 8765] [--bind ADDRESS] [--directory FOLDER]

The same as `python3 -m http.server`, with one difference: every answer tells the browser to ask
again before it uses its own copy (Cache-Control: no-cache). The plain server says nothing about
caching, so a browser guesses, and keeps a script that had not changed for days for hours without
asking. After an update it can then run new files beside old ones, and a page that needs both
breaks. Asking again costs little: a file that has not changed is answered "not modified".
(The deployed site has its own rules, in _headers.)
"""
import argparse
import functools
import http.server
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='Serve the game, with no stale copies kept by the browser.')
    ap.add_argument('port', nargs='?', type=int, default=8765)
    ap.add_argument('--bind', '-b', default='127.0.0.1')
    ap.add_argument('--directory', '-d', default=os.path.join(here, '..'))
    args = ap.parse_args()
    root = os.path.abspath(args.directory)
    handler = functools.partial(Handler, directory=root)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print('Serving %s at http://%s:%d/' % (root, 'localhost' if args.bind in ('127.0.0.1', '') else args.bind, args.port), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
