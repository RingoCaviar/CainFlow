import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOpenImmersivePreview } from '../js/features/ui/runtime-controller.js';

test('a hidden fullscreen preview does not suppress toolbar and sidebar peek', () => {
    const hiddenOverlay = {
        classList: { contains: (className) => className === 'hidden' }
    };
    const documentRef = {
        querySelector: (selector) => selector === '.fullscreen-overlay' ? hiddenOverlay : null
    };

    assert.equal(hasOpenImmersivePreview(documentRef), false);
});

test('an active fullscreen preview suppresses toolbar and sidebar peek', () => {
    const documentRef = {
        querySelector: (selector) => selector === '.fullscreen-overlay.active' ? {} : null
    };

    assert.equal(hasOpenImmersivePreview(documentRef), true);
});
