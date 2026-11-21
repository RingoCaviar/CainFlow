import argparse

from backend.desktop import run_desktop
from backend.main import run_browser


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CainFlow launcher')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--browser', action='store_true', help='run in browser debugging mode')
    mode.add_argument('--headless', action='store_true', help='run the local service without opening a window')
    parser.add_argument('--port', type=int, default=None, help='browser or headless mode HTTP port')
    args = parser.parse_args()
    if args.browser or args.headless:
        run_browser(args.port, open_browser=not args.headless)
    else:
        raise SystemExit(run_desktop())
