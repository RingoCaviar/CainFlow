import argparse

from backend.desktop import run_desktop
from backend.main import run_browser


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CainFlow launcher')
    parser.add_argument('--browser', action='store_true', help='run in browser debugging mode')
    parser.add_argument('--port', type=int, default=None, help='browser mode HTTP port')
    args = parser.parse_args()
    if args.browser:
        run_browser(args.port)
    else:
        raise SystemExit(run_desktop())
