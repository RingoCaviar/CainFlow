import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchConnectionModeApi } from '../js/canvas/batch-connection-mode.js';
import { appendMappedConnectionSnapshots } from '../js/canvas/connection-copy-utils.js';
import '../js/features/execution/protocols/openai.js';

function classes(initial = []) {
    const values = new Set(initial);
    return { contains: name => values.has(name), add: name => values.add(name),
        remove: name => values.delete(name), toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); } };
}
function port(nodeId, name, type, direction, options = {}) {
    return { dataset: { nodeId, port: name, type, direction }, hidden: !!options.hidden,
        classList: classes(options.canonical ? ['image-first-canonical-input'] : []),
        querySelector: () => null };
}
function node(id, type, ports, data = {}) {
    return { id, type, data, apiConfigId: type === 'ImageGenerate' ? 'image' : '',
        el: { classList: classes(), querySelectorAll: selector => ports.filter(item => selector.includes(`"${item.dataset.direction}"`)) } };
}
function target(id = 'target') {
    return node(id, 'ImageGenerate', [
        port(id, 'prompt', 'text', 'input', { canonical: true }),
        port(id, 'camera_prompt', 'text', 'input', { canonical: true }),
        port(id, 'referenceImages', 'image', 'input', { canonical: true }),
        port(id, 'mask', 'image', 'input', { canonical: true }),
        port(id, 'params', 'params', 'input', { canonical: true }),
        port(id, 'auto', 'any', 'input'), port(id, 'image', 'image', 'output')
    ]);
}
function harness(nodes, connections = [], callbacks = {}) {
    const state = { nodes: new Map(nodes.map(item => [item.id, item])), connections,
        runningNodeIds: new Set(), models: [{ id: 'image', modelId: 'gpt-image-1', protocol: 'openai' }] };
    const submissions = [], messages = [];
    let history = 0;
    const api = createBatchConnectionModeApi({ state,
        canvasContainer: { classList: classes(), dataset: {} }, documentRef: { body: { classList: classes() } },
        pushHistory: () => { history += 1; }, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {},
        showToast: message => messages.push(message),
        connectPorts: (source, destination) => { submissions.push({ source, destination }); return true; }, ...callbacks });
    return { state, api, submissions, messages, history: () => history };
}

test('batch connecting to a migrated generation card rejects capacity instead of using its hidden reference port', () => {
    const source = node('source', 'ImageImport', [port('source', 'image', 'image', 'output')], { imageList: ['a', 'b', 'c'] });
    const old = node('old', 'ImageImport', [], { imageList: ['d', 'e', 'f'] });
    const edge = { id: 'old-edge', from: { nodeId: 'old', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 8 };
    const { api, state, submissions, history } = harness([source, old, target()], [edge]);
    api.enter('source'); api.connectTo('target');
    assert.deepEqual(state.connections, [edge]);
    assert.deepEqual(submissions, []);
    assert.equal(history(), 0);
});

test('batch input routing submits the exact source output through the sole universal endpoint once', () => {
    const source = node('camera', 'CameraControl', [port('camera', 'text', 'text', 'output')]);
    const { api, state, submissions, history } = harness([source, target()]);
    api.enter('camera'); api.connectTo('target');
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0], {
        source: { nodeId: 'camera', portName: 'text', dataType: 'text', isOutput: true },
        destination: { nodeId: 'target', port: 'auto', type: 'any', dir: 'input' }
    });
    assert.deepEqual(state.connections, [], 'the shared graph connection API owns the mutation');
    assert.equal(history(), 0, 'the shared connection API owns its single history record');
});

test('batch connection validation and graph transition guards reject before any history or mutation', () => {
    for (const guard of ['canvasPlanApplying', 'historyTransitionInProgress']) {
        const source = node('source', 'Text', [port('source', 'text', 'text', 'output')]);
        const { api, state, submissions, history } = harness([source, target()]);
        api.enter('source'); state[guard] = true; api.connectTo('target');
        assert.deepEqual(state.connections, []);
        assert.deepEqual(submissions, []);
        assert.equal(history(), 0);
    }
    const source = node('source', 'Text', [port('source', 'text', 'text', 'output')]);
    const { api, state, submissions } = harness([source, target()], [], { validateConnection: () => '来源已变化' });
    api.enter('source'); api.connectTo('target');
    assert.deepEqual(submissions, []);
    assert.deepEqual(state.connections, []);
});

test('a migrated batch target has no direct mutation fallback when the shared connection API is absent', () => {
    const source = node('source', 'Text', [port('source', 'text', 'text', 'output')]);
    const { api, state, history } = harness([source, target()], [], { connectPorts: null });
    api.enter('source'); api.connectTo('target');
    assert.deepEqual(state.connections, []);
    assert.equal(history(), 0);
});

test('copying mask connections retains their consumption qualification, logical endpoint and stored order', () => {
    for (const maskConsumption of ['single', 'legacy-first']) {
        const source = node('copy-source', 'ImageImport', [port('copy-source', 'image', 'image', 'output')]);
        const destination = target('copy-target');
        const state = { nodes: new Map([[source.id, source], [destination.id, destination]]), connections: [], runningNodeIds: new Set() };
        const original = { id: 'original', from: { nodeId: 'source', port: 'image' },
            to: { nodeId: 'target', port: 'mask' }, type: 'image', order: 4, maskConsumption };
        const result = appendMappedConnectionSnapshots({ state,
            idMap: new Map([['source', source.id], ['target', destination.id]]), internalConnections: [original] });
        assert.equal(result.added, 1);
        assert.deepEqual({ ...state.connections[0], id: original.id }, { ...original,
            from: { nodeId: source.id, port: 'image' }, to: { nodeId: destination.id, port: 'mask' } });
    }
});

test('batch mode retains reverse-direction discovery and the existing unmigrated image connection behavior', () => {
    const text = node('text', 'Text', [port('text', 'text', 'text', 'output')]);
    const reverse = harness([target('anchor'), text]);
    reverse.api.enter('anchor'); reverse.api.connectTo('text');
    assert.deepEqual(reverse.submissions, [{
        source: { nodeId: 'text', portName: 'text', dataType: 'text', isOutput: true },
        destination: { nodeId: 'anchor', port: 'auto', type: 'any', dir: 'input' }
    }]);
    const source = node('source', 'ImageImport', [port('source', 'image', 'image', 'output')]);
    const preview = node('preview', 'ImagePreview', [port('preview', 'image', 'image', 'input')]);
    const old = harness([source, preview]);
    old.api.enter('source'); old.api.connectTo('preview');
    assert.equal(old.history(), 1);
    assert.equal(old.state.connections.length, 1);
    assert.deepEqual(old.state.connections[0].to, { nodeId: 'preview', port: 'image' });
    assert.deepEqual(old.submissions, []);
});

test('batch mode ignores an input hidden with its native hidden attribute', () => {
    const source = node('source', 'ImageImport', [port('source', 'image', 'image', 'output')]);
    const preview = node('preview', 'ImagePreview', [port('preview', 'image', 'image', 'input', { hidden: true })]);
    const { api, state, history } = harness([source, preview]);
    api.enter('source'); api.connectTo('preview');
    assert.deepEqual(state.connections, []);
    assert.equal(history(), 0);
});

test('restoring a complete migrated reference graph is not truncated by the old fixed connection count', () => {
    const source = node('copy-source', 'ImageImport', [port('copy-source', 'image', 'image', 'output')]);
    const destination = target('copy-target');
    const existing = Array.from({ length: 64 }, (_, index) => ({ id: `existing-${index}`,
        from: { nodeId: `source-${index}`, port: 'image' }, to: { nodeId: destination.id, port: 'referenceImages' }, type: 'image', order: index }));
    const state = { nodes: new Map([[source.id, source], [destination.id, destination]]), connections: existing, runningNodeIds: new Set() };
    for (let index = 0; index < 64; index += 1) state.nodes.set(`source-${index}`, node(`source-${index}`, 'ImageImport', []));
    const result = appendMappedConnectionSnapshots({ state,
        idMap: new Map([['source', source.id], ['target', destination.id]]),
        internalConnections: [{ id: 'last', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 64 }] });
    assert.equal(result.added, 1);
    assert.equal(state.connections.length, 65);
    assert.deepEqual(state.connections.slice(0, 64), existing.slice(0, 64));
    assert.equal(state.connections.at(-1).order, 64);
});
