import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';

function classList() {
    const values = new Set();
    return {
        add(value) { values.add(value); },
        remove(...items) { items.forEach((value) => values.delete(value)); },
        contains(value) { return values.has(value); },
        toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); }
    };
}

function port(nodeId, name, type, direction, x, y) {
    const dot = { getBoundingClientRect: () => ({ left: x - 6, top: y - 6, width: 12, height: 12 }) };
    return {
        dataset: { nodeId, port: name, type, direction },
        classList: classList(),
        offsetParent: {},
        querySelector: () => dot
    };
}

function harness() {
    const ports = [
        port('source', 'out', 'image', 'output', 0, 0),
        port('wrong', 'in', 'text', 'input', 91, 100),
        port('near', 'in', 'image', 'input', 100, 100),
        port('far', 'in', 'image', 'input', 115, 100),
        port('running', 'in', 'image', 'input', 96, 100)
    ];
    const nodes = new Map(ports.map((p) => [p.dataset.nodeId, {
        x: p.querySelector().getBoundingClientRect().left + 6,
        y: 100,
        type: 'Test',
        el: { classList: classList(), querySelectorAll: () => [] }
    }]));
    const state = {
        canvas: { x: 0, y: 0, zoom: 1 },
        connections: [], nodes,
        runningNodeIds: new Set(['running'])
    };
    const api = createConnectionsApi({
        state,
        canvasContainer: {}, connectionsGroup: {}, tempConnection: {}, originAxes: {},
        getNodeById: (id) => nodes.get(id),
        createBezierPath: () => '', getConnectionSamplePoints: () => [],
        pushHistory() {}, showToast() {}, scheduleSave() {},
        documentRef: {
            defaultView: {},
            querySelectorAll: (selector) => selector === '.node-port' ? ports : []
        }
    });
    return { api, ports, state, source: {
        nodeId: 'source', portName: 'out', dataType: 'image', isOutput: true
    } };
}

test('snaps to the closest usable port within a fixed screen radius', () => {
    const { api, source } = harness();
    assert.equal(api.getNearestConnectionTarget(source, 93, 100)?.target.nodeId, 'near');
    assert.equal(api.getNearestConnectionTarget(source, 150, 100), null);
});

test('feedback uses the same validity rules as creating a connection', () => {
    const { api, source, ports, state } = harness();
    api.updateConnectionTargetFeedback(source, 93, 100);
    assert.equal(ports[1].classList.contains('connection-target-unavailable'), true);
    assert.equal(ports[2].classList.contains('connection-target-nearest'), true);
    assert.equal(ports[4].classList.contains('connection-target-unavailable'), true);
    state.connections.push({ from: { nodeId: 'source', port: 'out' }, to: { nodeId: 'near', port: 'in' } });
    assert.equal(api.getConnectionTargetError(source, {
        nodeId: 'near', port: 'in', type: 'image', dir: 'input'
    }), '连接已存在');
    api.clearConnectionTargetFeedback();
    assert.equal(ports[2].classList.contains('connection-target-nearest'), false);
});

test('reverse connection starts at an input and accepts only an output of the matching type', () => {
    const { api, ports } = harness();
    const source = { nodeId: 'near', portName: 'in', dataType: 'image', isOutput: false };
    assert.equal(api.getNearestConnectionTarget(source, 0, 0)?.target.nodeId, 'source');
    assert.equal(api.getConnectionTargetError(source, {
        nodeId: 'far', port: 'in', type: 'image', dir: 'input'
    }), '不能连接两个输入');
    ports[0].classList.add('is-hidden-by-collapse');
    assert.equal(api.getNearestConnectionTarget(source, 0, 0), null);
});
