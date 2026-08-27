import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';
import { createBezierPath, getConnectionSamplePoints } from '../js/canvas/geometry.js';

function createTemporaryConnectionHarness() {
    let path = '';
    const tempConnection = {
        setAttribute(name, value) {
            if (name === 'd') path = value;
        }
    };
    const documentRef = {
        defaultView: {},
        querySelectorAll() { return []; }
    };
    const api = createConnectionsApi({
        state: {
            canvas: { x: 0, y: 0, zoom: 1 },
            connectionLineType: 'bezier',
            connections: [],
            nodes: new Map()
        },
        canvasContainer: {},
        connectionsGroup: {},
        tempConnection,
        originAxes: {},
        getNodeById() { return null; },
        createBezierPath,
        getConnectionSamplePoints,
        pushHistory() {},
        showToast() {},
        scheduleSave() {},
        documentRef
    });

    return {
        draw: api.drawTempConnection,
        getPath() { return path; }
    };
}

test('temporary connection enters a left-side input port from the left', () => {
    const harness = createTemporaryConnectionHarness();

    harness.draw(120, 80, 35, 120, false);

    assert.equal(harness.getPath(), 'M 35 120 C 95 120, 60 80, 120 80');
});
