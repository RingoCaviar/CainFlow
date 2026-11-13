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

function harness(ports = [
    port('source', 'out', 'image', 'output', 0, 0),
    port('wrong', 'in', 'text', 'input', 91, 100),
    port('near', 'in', 'image', 'input', 100, 100),
    port('far', 'in', 'image', 'input', 115, 100),
    port('running', 'in', 'image', 'input', 96, 100)
]) {
    const nodes = new Map();
    for (const p of ports) {
        const id = p.dataset.nodeId;
        if (nodes.has(id)) continue;
        nodes.set(id, {
            id,
            x: p.querySelector().getBoundingClientRect().left + 6,
            y: 100,
            type: 'Test',
            el: { classList: classList(), querySelectorAll: () => ports.filter(candidate => candidate.dataset.nodeId === id) }
        });
    }
    const state = {
        canvas: { x: 0, y: 0, zoom: 1 },
        connections: [], nodes,
        runningNodeIds: new Set(['running'])
    };
    const api = createConnectionsApi({
        state,
        canvasContainer: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) },
        connectionsGroup: {}, tempConnection: {}, originAxes: {},
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
    assert.equal(api.getNearestConnectionTarget(source, 500, 100, Number.MAX_SAFE_INTEGER)?.target.nodeId, 'far');
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
    ports[0].offsetParent = null;
    assert.equal(api.getNearestConnectionTarget(source, 0, 0), null);
});

test('feedback shares one port measurement pass and skips unchanged class writes', () => {
    const { api, source, ports } = harness();
    let rectReads = 0;
    let writes = 0;
    ports.forEach((portEl) => {
        const dot = portEl.querySelector();
        const measure = dot.getBoundingClientRect;
        dot.getBoundingClientRect = () => { rectReads += 1; return measure(); };
        const toggle = portEl.classList.toggle;
        portEl.classList.toggle = (...args) => { writes += 1; toggle(...args); };
    });
    api.updateConnectionTargetFeedback(source, NaN, NaN);
    assert.equal(rectReads, ports.length);
    writes = 0;
    api.updateConnectionTargetFeedback(source, NaN, NaN);
    assert.equal(rectReads, ports.length, 'unchanged port geometry survives subsequent feedback frames');
    assert.equal(writes, 0);
});

test('snapping uses fresh geometry after a node changes and drop checks current compatibility', () => {
    const { api, source, ports, state } = harness();
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');
    ports[2].querySelector().getBoundingClientRect = () => ({ left: 894, top: 94, width: 12, height: 12 });
    api.invalidateNodePortCache('near', { markDirty: false });
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'far');

    state.runningNodeIds.add('far');
    assert.equal(api.getNearestConnectionTarget(source, 100, 100), null);
    state.runningNodeIds.delete('far');
    ports[3].dataset.type = 'text';
    assert.equal(api.getNearestConnectionTarget(source, 100, 100), null);
});

test('nearby universal targets are rechecked against current topology in either drag direction', () => {
    const { api, ports, state } = harness([
        port('source', 'image', 'image', 'output', 0, 0),
        port('near', 'auto', 'any', 'input', 100, 100),
        port('far', 'auto', 'any', 'input', 118, 100)
    ]);
    state.nodes.get('source').type = 'ImageImport';
    state.nodes.get('near').type = 'ImagePreview';
    state.nodes.get('far').type = 'ImagePreview';
    const source = { nodeId: 'source', portName: 'image', dataType: 'image', isOutput: true };
    const nearInput = { nodeId: 'near', portName: 'auto', dataType: 'any', isOutput: false };
    const backwardEdge = { id: 'cycle-edge', from: { nodeId: 'near', port: 'image' }, to: { nodeId: 'source', port: 'image' } };
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');

    state.connections.push(backwardEdge);
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'far');
    assert.equal(ports[1].classList.contains('connection-target-unavailable'), true);
    assert.equal(api.updateConnectionTargetFeedback(nearInput, 0, 0), null);

    state.connections.pop();
    assert.equal(api.updateConnectionTargetFeedback(nearInput, 0, 0)?.target.nodeId, 'source');
    state.connections.push(backwardEdge);
    assert.equal(api.getNearestConnectionTarget(nearInput, 0, 0), null);
});

test('feedback refreshes running status without remeasuring stationary ports', () => {
    const { api, source, ports, state } = harness();
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');
    for (const portEl of ports) portEl.querySelector().getBoundingClientRect = () => assert.fail('stationary port was remeasured');
    state.runningNodeIds.add('near');
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'far');
    assert.equal(ports[2].classList.contains('connection-target-nearest'), false);
    assert.equal(ports[2].classList.contains('connection-target-unavailable'), true);
    assert.equal(ports[3].classList.contains('connection-target-nearest'), true);
});

test('dropping a wire fails if its original output disappears during the gesture', () => {
    const { api, source, ports, state } = harness();
    state.connecting = source;
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');
    ports.splice(0, 1);
    assert.equal(api.getNearestConnectionTarget(source, 100, 100), null);
    assert.match(api.getConnectionTargetError(source, {
        nodeId: 'near', port: 'in', type: 'image', dir: 'input'
    }), /来源端口已变化/);
});
