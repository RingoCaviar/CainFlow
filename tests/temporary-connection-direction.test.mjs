import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';
import { createBezierPath, getConnectionSamplePoints } from '../js/canvas/geometry.js';

function createTemporaryConnectionHarness(connectionLineType = 'bezier') {
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
            connectionLineType,
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

for (const style of ['bezier', 'orthogonal']) {
    test(`temporary ${style} wires are separated when all ports share a row`, () => {
        const harness = createTemporaryConnectionHarness(style);
        harness.draw(30, 80, 220, 80, true, [{ x: 30, y: 80 }, { x: 100, y: 80 }]);

        const wires = harness.getPath().split(/(?=M )/);
        assert.equal(wires.length, 2);
        assert.match(wires[0], /^M 30 80 .*220 80\s*$/);
        assert.match(wires[1], /^M 100 80 .*220 80$/);
        const yCoordinates = wire => wire.trim().match(/-?[\d.]+/g).filter((_, index) => index % 2).map(Number);
        assert.ok(yCoordinates(wires[0]).some(y => y < 80));
        assert.ok(yCoordinates(wires[1]).some(y => y > 80));
    });
}
