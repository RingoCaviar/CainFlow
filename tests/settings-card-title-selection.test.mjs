import assert from 'node:assert/strict';
import test from 'node:test';

import { createCardToggleGestureGuard } from '../js/features/settings/card-toggle-gesture.js';

test('a title-selection gesture cannot become a card toggle when released outside the input', () => {
    const scheduled = [];
    const guard = createCardToggleGestureGuard({ scheduleClear: (callback) => scheduled.push(callback) });

    guard.beginTitleSelection();
    guard.endPointerGesture();

    assert.equal(guard.consumeToggleSuppression(), true);
    scheduled.forEach((callback) => callback());
    assert.equal(guard.consumeToggleSuppression(), false);
});

test('ordinary card clicks are not suppressed', () => {
    const guard = createCardToggleGestureGuard();

    assert.equal(guard.consumeToggleSuppression(), false);
});
