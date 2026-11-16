import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseCanvasShortcuts } from '../js/features/ui/shortcut-guard.js';

for (const panel of ['.image-parameter-panel', '#prompt-agent-panel', '#canvas-run-scope']) {
    test(`focused ${panel} controls do not apply editing shortcuts to the canvas underneath`, () => {
        const target = { nodeType: 1, closest: selector => selector.includes(panel) ? {} : null };
        const documentRef = { activeElement: target, querySelectorAll: () => [] };
        assert.equal(canUseCanvasShortcuts({ event: { target }, state: { isMouseOverCanvas: true }, documentRef,
            canvasContainer: { contains: () => false }, windowRef: {} }), false);
    });
}

test('activation shortcuts require canvas focus and ignore IME confirmation', () => {
    const body = { nodeType: 1, closest: () => null };
    const canvas = { nodeType: 1, closest: () => null, contains: target => target === canvas };
    const documentRef = { activeElement: body, querySelectorAll: () => [] };
    const options = { state: { isMouseOverCanvas: true }, documentRef, canvasContainer: canvas, windowRef: {} };
    assert.equal(canUseCanvasShortcuts({ ...options, requireCanvasFocus: true }), false);
    assert.equal(canUseCanvasShortcuts(options), true);
    documentRef.activeElement = canvas;
    assert.equal(canUseCanvasShortcuts({ ...options, requireCanvasFocus: true }), true);
    assert.equal(canUseCanvasShortcuts({ ...options, requireCanvasFocus: true, event: { target: canvas, isComposing: true } }), false);
    assert.equal(canUseCanvasShortcuts({ ...options, requireCanvasFocus: true, event: { target: canvas, keyCode: 229 } }), false);
});
