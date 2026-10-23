"""Persist the desktop window bounds outside the workflow document."""

import json
import os


DEFAULT_BOUNDS = {'width': 1440, 'height': 900}
MIN_WIDTH = 1024
MIN_HEIGHT = 700


def load_window_bounds(path, screens=()):
    try:
        with open(path, encoding='utf-8') as stream:
            saved = json.load(stream)
        bounds = {key: int(saved[key]) for key in ('x', 'y', 'width', 'height')}
    except (OSError, ValueError, TypeError, KeyError):
        return DEFAULT_BOUNDS.copy()
    if not (MIN_WIDTH <= bounds['width'] <= 10000 and MIN_HEIGHT <= bounds['height'] <= 10000):
        return DEFAULT_BOUNDS.copy()
    # A monitor may have been unplugged. Leave positioning to the window manager.
    if screens and not any(
        bounds['x'] < screen.x + screen.width - 100
        and bounds['x'] + bounds['width'] > screen.x + 100
        and bounds['y'] < screen.y + screen.height - 100
        and bounds['y'] + bounds['height'] > screen.y + 100
        for screen in screens
    ):
        return {'width': bounds['width'], 'height': bounds['height']}
    return bounds


def save_window_bounds(path, window):
    try:
        bounds = {key: int(getattr(window, key)) for key in ('x', 'y', 'width', 'height')}
        if bounds['width'] < MIN_WIDTH or bounds['height'] < MIN_HEIGHT:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = path + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as stream:
            json.dump(bounds, stream)
        os.replace(temporary, path)
    except (OSError, ValueError, TypeError):
        # Window shutdown must not fail because the optional preference is unavailable.
        pass
