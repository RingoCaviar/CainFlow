import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseCanvasShortcuts } from '../js/features/ui/shortcut-guard.js';

for (const panel of ['.image-parameter-panel', '#prompt-agent-panel', '.image-panel-switcher']) {
    test(`focused ${panel} controls do not apply editing shortcuts to the canvas underneath`, () => {
        const target = { nodeType: 1, closest: selector => selector.includes(panel) ? {} : null };
        const documentRef = { activeElement: target, querySelectorAll: () => [] };
        assert.equal(canUseCanvasShortcuts({ event: { target }, state: { isMouseOverCanvas: true }, documentRef,
            canvasContainer: { contains: () => false }, windowRef: {} }), false);
    });
}
