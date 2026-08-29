import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportApi } from '../js/canvas/viewport.js';

function createHarness() {
    const calls = [];
    const documentRef = { dispatchEvent() {} };
    const container = {
        ownerDocument: documentRef,
        style: { setProperty() {} },
        clientWidth: 800,
        clientHeight: 600
    };
    const elements = {
        canvasContainer: container,
        nodesLayer: { style: { setProperty() {} } },
        connectionsGroup: { setAttribute() {} },
        originAxes: { setAttribute() {} },
        zoomLevel: { textContent: '' }
    };
    const api = createViewportApi({
        state: { canvas: { x: 10, y: 20, zoom: 1 } },
        elements,
        updateAllConnections() {},
        scheduleConnectionRefresh(options) { calls.push(options); },
        requestAnimationFrameRef(callback) { callback(); }
    });
    return { api, calls };
}

test('settleConnections is explicit and does not depend on reason', () => {
    const { api, calls } = createHarness();
    api.updateCanvasTransform({ connectionRefreshReason: 'pan-settled' });
    assert.equal(calls.at(-1).settle, false);

    api.updateCanvasTransform({ connectionRefreshReason: 'pan-settled', settleConnections: true });
    assert.equal(calls.at(-1).settle, true);
});

test('continuous Canvas zoom reads the themed grid spacing only once', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;
    let styleReadCount = 0;
    globalThis.getComputedStyle = () => ({
        getPropertyValue(name) {
            assert.equal(name, '--canvas-dot-spacing');
            styleReadCount += 1;
            return '24px';
        }
    });

    try {
        const { api } = createHarness();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });

        assert.equal(styleReadCount, 1);
    } finally {
        globalThis.getComputedStyle = originalGetComputedStyle;
    }
});

test('refreshing Canvas theme metrics reloads the themed grid spacing', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;
    let themedSpacing = '22px';
    let styleReadCount = 0;
    globalThis.getComputedStyle = () => ({
        getPropertyValue() {
            styleReadCount += 1;
            return themedSpacing;
        }
    });

    try {
        const { api } = createHarness();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
        themedSpacing = '24px';

        api.refreshCanvasThemeMetrics();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });

        assert.equal(styleReadCount, 2);
    } finally {
        globalThis.getComputedStyle = originalGetComputedStyle;
    }
});
