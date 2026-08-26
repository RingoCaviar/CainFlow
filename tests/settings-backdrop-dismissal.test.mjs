import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackdropDismissalGuard } from '../js/features/settings/backdrop-dismissal.js';

test('does not dismiss settings when a text-selection gesture starts inside the panel', () => {
    const overlay = {};
    const panel = { contains: (target) => target === panel };
    const guard = createBackdropDismissalGuard({ overlay, panel });

    guard.recordPointerDown({ target: panel });

    assert.equal(guard.shouldDismiss({ target: overlay }), false);
});

test('dismisses settings for a complete click gesture on the backdrop', () => {
    const overlay = {};
    const panel = { contains: (target) => target === panel };
    const guard = createBackdropDismissalGuard({ overlay, panel });

    guard.recordPointerDown({ target: overlay });

    assert.equal(guard.shouldDismiss({ target: overlay }), true);
});
