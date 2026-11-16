import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';
import '../js/features/execution/protocols/api6789-video.js';
import '../js/features/execution/protocols/veo-unified.js';

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
], { observeLayout = false, addNode, showToast = () => {} } = {}) {
    const mutations = [];
    let notifyLayout;
    const layer = { addEventListener() {} };
    const MutationObserver = observeLayout ? class {
        constructor(callback) { notifyLayout = callback; }
        observe() {}
        takeRecords() { return mutations.splice(0); }
    } : undefined;
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
        canvasContainer: {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
            querySelector: selector => observeLayout && selector === '#nodes-layer' ? layer : null
        },
        connectionsGroup: {}, tempConnection: {}, originAxes: {},
        getNodeById: (id) => nodes.get(id),
        createBezierPath: () => '', getConnectionSamplePoints: () => [],
        addNode, pushHistory() {}, showToast, scheduleSave() {},
        documentRef: {
            defaultView: { MutationObserver },
            querySelectorAll: (selector) => selector === '.node-port' ? ports : []
        }
    });
    const deliverMutations = () => notifyLayout(mutations.splice(0));
    return { api, ports, state, mutations, deliverMutations, source: {
        nodeId: 'source', portName: 'out', dataType: 'image', isOutput: true
    } };
}

test('snaps to the closest usable port within a fixed screen radius', () => {
    const { api, source } = harness();
    assert.equal(api.getNearestConnectionTarget(source, 93, 100)?.target.nodeId, 'near');
    assert.equal(api.getNearestConnectionTarget(source, 150, 100), null);
    assert.equal(api.getNearestConnectionTarget(source, 500, 100, Number.MAX_SAFE_INTEGER)?.target.nodeId, 'far');
});

test('reverse drag-create refuses a candidate when its destination role changes', () => {
    const warnings = [];
    const { api, state } = harness([
        port('compare', 'auto', 'any', 'input', 100, 100),
        port('existing', 'image', 'image', 'output', 10, 100)
    ], { addNode: () => assert.fail('a stale candidate must be rejected before node creation'), showToast: message => warnings.push(message) });
    state.nodes.get('compare').type = 'ImageCompare';
    state.nodes.get('existing').type = 'ImageImport';
    const source = { nodeId: 'compare', portName: 'auto', dataType: 'any', isOutput: false };
    const getImport = () => api.getCompatibleNodeTypeCandidates(source).find(candidate => candidate.type === 'ImageImport');
    const candidate = getImport();
    assert.equal(candidate.destinationPort, 'imageA');
    assert.match(candidate.matchLabel, /接入对比 A/);
    const edge = { id: 'first-image', from: { nodeId: 'existing', port: 'image' }, to: { nodeId: 'compare', port: 'imageA' }, type: 'image' };
    state.connections.push(edge);
    assert.equal(getImport().destinationPort, 'imageB');
    assert.equal(api.createNodeFromConnectionCandidate(source, candidate, 0, 0), false);
    assert.deepEqual(state.connections, [edge]);
    assert.deepEqual(warnings, ['节点配置已变化，请重新拖线创建节点']);
});

test('forward drag-create refuses the same node type after a different model changes its matched port', () => {
    const warnings = [];
    const { api, state } = harness([port('source', 'image', 'image', 'output', 10, 100)], {
        addNode: () => assert.fail('a stale candidate must be rejected before node creation'),
        showToast: message => warnings.push(message)
    });
    state.nodes.get('source').type = 'ImageImport';
    state.models = [
        { id: 'frames', modelId: 'veo-3', protocol: 'veo-unified', taskType: 'video' },
        { id: 'references', modelId: 'kling-o3', protocol: 'async-video-api', taskType: 'video' }
    ];
    state.nodeDefaults = { VideoGenerate: { apiConfigId: 'frames' } };
    const source = { nodeId: 'source', portName: 'image', dataType: 'image', isOutput: true };
    const getVideo = () => api.getCompatibleNodeTypeCandidates(source).find(candidate => candidate.type === 'VideoGenerate');
    const candidate = getVideo();
    assert.equal(candidate.matchPortName, 'image_1');
    state.nodeDefaults.VideoGenerate.apiConfigId = 'references';
    assert.equal(getVideo().matchPortName, 'referenceImages');
    assert.equal(api.createNodeFromConnectionCandidate(source, candidate, 0, 0), false);
    assert.deepEqual(warnings, ['节点配置已变化，请重新拖线创建节点']);
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

test('releasing a wire measures the nearby ports at the final coordinates and leaves distant ports alone', () => {
    const distant = port('distant', 'in', 'image', 'input', 450, 100);
    const final = port('final', 'in', 'image', 'input', 250, 100);
    const { api, source, state, mutations, deliverMutations } = harness([
        port('source', 'out', 'image', 'output', 0, 0),
        port('near', 'in', 'image', 'input', 100, 100), final, distant
    ], { observeLayout: true });
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');

    const dot = final.querySelector();
    const measure = dot.getBoundingClientRect;
    let finalMeasurements = 0;
    dot.getBoundingClientRect = () => { finalMeasurements += 1; return measure(); };
    distant.querySelector().getBoundingClientRect = () => assert.fail('distant port was remeasured at release');

    mutations.push({ type: 'childList', target: {
        id: 'running-time',
        parentElement: { matches: selector => selector === '.node-time-badge' },
        closest: selector => selector.includes('.node-header') ? distant : null
    }, addedNodes: [], removedNodes: [] });
    deliverMutations();
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');

    assert.equal(api.getNearestConnectionTarget(source, 247, 100)?.target.nodeId, 'final');
    assert.equal(finalMeasurements, 1);
    state.runningNodeIds.add('final');
    assert.equal(api.getNearestConnectionTarget(source, 247, 100), null, 'the cached geometry does not preserve an obsolete validation');
});

for (const change of ['position', 'content']) test(`a pending ${change} change can bring a distant port into the release radius`, () => {
    const moved = port('moved', 'in', 'image', 'input', 450, 100);
    const { api, source, mutations } = harness([
        port('source', 'out', 'image', 'output', 0, 0),
        port('near', 'in', 'image', 'input', 100, 100), moved
    ], { observeLayout: true });
    assert.equal(api.updateConnectionTargetFeedback(source, 100, 100)?.target.nodeId, 'near');

    moved.querySelector().getBoundingClientRect = () => ({ left: 96, top: 94, width: 12, height: 12 });
    mutations.push({
        type: 'attributes', attributeName: 'style',
        target: change === 'position'
            ? { matches: selector => selector === '.node', querySelector: () => moved }
            : { matches: () => false, closest: selector => selector === '.node-body' ? moved : null }
    });

    assert.deepEqual(api.getNearestConnectionTarget(source, 102, 100), {
        target: { nodeId: 'moved', port: 'in', type: 'image', dir: 'input' }, position: { x: 102, y: 100 }
    });
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
