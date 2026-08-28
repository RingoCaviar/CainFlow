import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migrateLegacyWorkflowData } from '../js/features/persistence/legacy-node-migration.js';
import { appendMappedConnectionSnapshots } from '../js/canvas/connection-copy-utils.js';
import {
    createContextMenuControllerApi,
    disconnectReferenceImageConnections
} from '../js/features/ui/context-menu-controller.js';
import { serializeConnection } from '../js/canvas/connection-snapshot.js';
import { appendReferenceImages } from '../js/features/execution/execution-data-utils.js';
import { hasRunningEndpoint } from '../js/features/media/utils/ui-state-helpers.js';
import {
    getNextInputConnectionOrder,
    getReferenceImageInputPorts,
    orderInputConnections
} from '../js/nodes/reference-image-ports.js';

const connectionsSource = await readFile(new URL('../js/canvas/connections.js', import.meta.url), 'utf8');
const runnerSource = await readFile(new URL('../js/features/execution/workflow-runner.js', import.meta.url), 'utf8');
const requestUtilsSource = await readFile(new URL('../js/features/execution/provider-request-utils.js', import.meta.url), 'utf8');
const contextMenuSource = await readFile(new URL('../js/features/ui/context-menu-controller.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('reference image nodes expose one ordered multi-connection input', () => {
    assert.deepEqual(getReferenceImageInputPorts({}, 'ImageGenerate'), [
        { name: 'referenceImages', type: 'image', label: '参考图', multiple: true }
    ]);
    assert.deepEqual(getReferenceImageInputPorts({}, 'TextChat'), [
        { name: 'referenceImages', type: 'image', label: '参考图', multiple: true }
    ]);
    assert.deepEqual(getReferenceImageInputPorts({}, 'VideoGenerate'), [
        { name: 'image_1', type: 'image', label: '首帧' },
        { name: 'image_2', type: 'image', label: '尾帧' },
        { name: 'referenceImages', type: 'image', label: '参考图', multiple: true }
    ]);
});

test('multi-connection inputs retain order when other input ports are interleaved', () => {
    const connections = [
        { id: 'late', to: { port: 'referenceImages' }, order: 1 },
        { id: 'prompt', to: { port: 'prompt' } },
        { id: 'early', to: { port: 'referenceImages' }, order: 0 }
    ];

    assert.deepEqual(
        orderInputConnections('ImageGenerate', connections).map((connection) => connection.id),
        ['early', 'late', 'prompt']
    );
});

test('next multi-connection order is scoped to one target input', () => {
    const connections = [
        { to: { nodeId: 'target', port: 'referenceImages' }, order: 3 },
        { to: { nodeId: 'other', port: 'referenceImages' }, order: 20 },
        { to: { nodeId: 'target', port: 'prompt' }, order: 30 },
        { to: { nodeId: 'target', port: 'referenceImages' }, order: 7 }
    ];

    assert.equal(getNextInputConnectionOrder(connections, {
        nodeId: 'target',
        port: 'referenceImages'
    }), 8);
});

test('pasted multi-connections append after the target order while retaining group order', () => {
    const portElement = (port, direction, multiple = false) => ({
        dataset: { port, direction, ...(multiple ? { multiple: 'true' } : {}) }
    });
    const nodeElement = (ports) => ({
        querySelectorAll: (selector) => ports.filter((port) => selector.includes(port.dataset.direction)),
        querySelector: (selector) => ports.find((port) => (
            selector.includes(`data-port="${port.dataset.port}"`) &&
            selector.includes(`data-direction="${port.dataset.direction}"`)
        )) || null,
        classList: { contains: () => false }
    });
    const state = {
        connections: [{
            id: 'existing',
            from: { nodeId: 'existing-source', port: 'image' },
            to: { nodeId: 'target', port: 'referenceImages' },
            type: 'image',
            order: 4
        }],
        nodes: new Map([
            ['new-a', { type: 'ImageImport', el: nodeElement([portElement('image', 'output')]) }],
            ['new-b', { type: 'ImageImport', el: nodeElement([portElement('image', 'output')]) }],
            ['target', { type: 'ImageGenerate', el: nodeElement([portElement('referenceImages', 'input', true)]) }]
        ]),
        runningNodeIds: new Set()
    };

    const result = appendMappedConnectionSnapshots({
        state,
        idMap: new Map([['old-a', 'new-a'], ['old-b', 'new-b'], ['old-target', 'target']]),
        internalConnections: [
            { from: { nodeId: 'old-b', port: 'image' }, to: { nodeId: 'old-target', port: 'referenceImages' }, type: 'image', order: 1 },
            { from: { nodeId: 'old-a', port: 'image' }, to: { nodeId: 'old-target', port: 'referenceImages' }, type: 'image', order: 0 }
        ]
    });

    assert.equal(result.added, 2);
    assert.deepEqual(
        state.connections.slice(1).map((connection) => [connection.from.nodeId, connection.order]),
        [['new-a', 5], ['new-b', 6]]
    );
});

test('pasted multi-connections retain one explicit order across internal and external snapshots', () => {
    const portElement = (port, direction, multiple = false) => ({
        dataset: { port, direction, ...(multiple ? { multiple: 'true' } : {}) }
    });
    const nodeElement = (ports) => ({
        querySelectorAll: (selector) => ports.filter((port) => selector.includes(port.dataset.direction)),
        classList: { contains: () => false }
    });
    const state = {
        connections: [],
        nodes: new Map([
            ['external-source', { type: 'ImageImport', el: nodeElement([portElement('image', 'output')]) }],
            ['new-source', { type: 'ImageImport', el: nodeElement([portElement('image', 'output')]) }],
            ['new-target', { type: 'ImageGenerate', el: nodeElement([portElement('referenceImages', 'input', true)]) }]
        ]),
        runningNodeIds: new Set()
    };

    const result = appendMappedConnectionSnapshots({
        state,
        idMap: new Map([['old-source', 'new-source'], ['old-target', 'new-target']]),
        internalConnections: [{
            from: { nodeId: 'old-source', port: 'image' },
            to: { nodeId: 'old-target', port: 'referenceImages' },
            type: 'image',
            order: 1
        }],
        externalConnections: [{
            from: { nodeId: 'external-source', port: 'image' },
            to: { nodeId: 'old-target', port: 'referenceImages' },
            type: 'image',
            order: 0
        }],
        includeExternalConnections: true
    });

    assert.equal(result.added, 2);
    assert.deepEqual(
        state.connections.map((connection) => [connection.from.nodeId, connection.order]),
        [['external-source', 0], ['new-source', 1]]
    );
});

test('pasting cannot exceed the multi-connection input limit', () => {
    const portElement = (port, direction, multiple = false) => ({
        dataset: { port, direction, ...(multiple ? { multiple: 'true' } : {}) }
    });
    const nodeElement = (ports) => ({
        querySelectorAll: (selector) => ports.filter((port) => selector.includes(port.dataset.direction)),
        classList: { contains: () => false }
    });
    const existingConnections = Array.from({ length: 64 }, (_, order) => ({
        id: `existing-${order}`,
        from: { nodeId: `existing-source-${order}`, port: 'image' },
        to: { nodeId: 'target', port: 'referenceImages' },
        type: 'image',
        order
    }));
    const state = {
        connections: existingConnections,
        nodes: new Map([
            ['new-source', { type: 'ImageImport', el: nodeElement([portElement('image', 'output')]) }],
            ['target', { type: 'ImageGenerate', el: nodeElement([portElement('referenceImages', 'input', true)]) }]
        ]),
        runningNodeIds: new Set()
    };

    const result = appendMappedConnectionSnapshots({
        state,
        idMap: new Map([['old-source', 'new-source'], ['old-target', 'target']]),
        internalConnections: [{
            from: { nodeId: 'old-source', port: 'image' },
            to: { nodeId: 'old-target', port: 'referenceImages' },
            type: 'image',
            order: 64
        }]
    });

    assert.deepEqual(result, {
        added: 0,
        skipped: 1,
        internalAdded: 0,
        externalAdded: 0,
        internalSkipped: 1,
        externalSkipped: 0
    });
    assert.equal(state.connections.length, 64);
});

test('disconnect-all is blocked while the target runs and records history before mutation', () => {
    const connection = { id: 'ref', to: { nodeId: 'target', port: 'referenceImages' } };
    const state = {
        connections: [connection],
        nodes: new Map([['target', { el: { classList: { contains: () => false } } }]]),
        runningNodeIds: new Set(['target'])
    };
    const events = [];

    assert.deepEqual(disconnectReferenceImageConnections({ state, nodeId: 'target', pushHistory: () => events.push('history') }), {
        disconnected: 0,
        blocked: true
    });
    assert.deepEqual(state.connections, [connection]);
    assert.deepEqual(events, []);

    state.runningNodeIds.clear();
    assert.deepEqual(disconnectReferenceImageConnections({ state, nodeId: 'target', pushHistory: () => events.push('history') }), {
        disconnected: 1,
        blocked: false
    });
    assert.deepEqual(state.connections, []);
    assert.deepEqual(events, ['history']);
});

test('disconnect-all is blocked while any reference image source runs', () => {
    const connection = {
        id: 'ref',
        from: { nodeId: 'source', port: 'image' },
        to: { nodeId: 'target', port: 'referenceImages' }
    };
    const state = {
        connections: [connection],
        nodes: new Map([
            ['source', { el: { classList: { contains: () => false } } }],
            ['target', { el: { classList: { contains: () => false } } }]
        ]),
        runningNodeIds: new Set(['source'])
    };
    const events = [];

    assert.deepEqual(disconnectReferenceImageConnections({
        state,
        nodeId: 'target',
        pushHistory: () => events.push('history')
    }), { disconnected: 0, blocked: true });
    assert.deepEqual(state.connections, [connection]);
    assert.deepEqual(events, []);
});

test('running endpoint detection covers state and rendered node status', () => {
    const connection = {
        from: { nodeId: 'source' },
        to: { nodeId: 'target' }
    };
    const nodes = new Map([
        ['source', { el: { classList: { contains: () => false } } }],
        ['target', { el: { classList: { contains: (name) => name === 'running' } } }]
    ]);
    const state = { runningNodeIds: new Set() };

    assert.equal(hasRunningEndpoint(connection, state, (nodeId) => nodes.get(nodeId)), true);
    nodes.get('target').el.classList.contains = () => false;
    state.runningNodeIds.add('source');
    assert.equal(hasRunningEndpoint(connection, state, (nodeId) => nodes.get(nodeId)), true);
    state.runningNodeIds.clear();
    assert.equal(hasRunningEndpoint(connection, state, (nodeId) => nodes.get(nodeId)), false);
});

test('disconnect-all reports removed topology without requesting a full connection refresh', () => {
    const menuHandlers = {};
    const contextMenu = {
        addEventListener: (type, handler) => { menuHandlers[type] = handler; },
        classList: { add: () => {} },
        contains: () => true,
        querySelectorAll: () => []
    };
    const state = {
        contextMenuNodeId: 'target',
        connections: [{
            id: 'ref',
            from: { nodeId: 'source', port: 'image' },
            to: { nodeId: 'target', port: 'referenceImages' }
        }],
        nodes: new Map([
            ['source', { el: { classList: { contains: () => false } } }],
            ['target', { el: { classList: { contains: () => false } } }]
        ]),
        runningNodeIds: new Set(),
        selectedNodes: new Set()
    };
    const topologyChanges = [];
    let fullRefreshes = 0;
    const api = createContextMenuControllerApi({
        state,
        canvasContainer: { addEventListener: () => {} },
        contextMenu,
        connectionCreatePopup: null,
        viewportApi: {},
        addNode: () => {},
        runWorkflow: () => {},
        createNodeFromConnectionCandidate: () => {},
        updateAllConnections: () => { fullRefreshes += 1; },
        connectionProjection: {
            topologyChanged: (change) => topologyChanges.push(change),
            nodeGeometryChanged: () => {}
        },
        documentRef: {
            addEventListener: () => {},
            defaultView: { confirm: () => true },
            getElementById: () => null,
            querySelectorAll: () => []
        }
    });
    api.initContextMenu();
    const item = {
        id: 'context-menu-disconnect-reference-images',
        dataset: {},
        classList: { contains: () => false },
        getAttribute: () => null
    };

    menuHandlers.click({
        target: { closest: () => item },
        preventDefault: () => {},
        stopPropagation: () => {}
    });

    assert.deepEqual(state.connections, []);
    assert.deepEqual(topologyChanges, [{ nodeIds: ['source', 'target'], connectionIds: ['ref'] }]);
    assert.equal(fullRefreshes, 0);
});

test('connection snapshots preserve valid multi-connection order only', () => {
    const connection = {
        id: 'ref',
        from: { nodeId: 'source', port: 'image' },
        to: { nodeId: 'target', port: 'referenceImages' },
        type: 'image',
        order: '3'
    };
    assert.deepEqual(serializeConnection(connection), { ...connection, order: 3 });
    assert.deepEqual(serializeConnection({ ...connection, order: 'invalid' }), {
        id: 'ref', from: connection.from, to: connection.to, type: 'image'
    });
});

test('reference image accumulation normalizes existing and incoming values in order', () => {
    assert.deepEqual(
        appendReferenceImages(['first'], { images: ['second', 'third'] }, 64),
        ['first', 'second', 'third']
    );
});

test('reference image accumulation rejects values beyond the connection limit', () => {
    assert.throws(
        () => appendReferenceImages(Array.from({ length: 64 }, (_, index) => `image-${index}`), 'overflow', 64),
        /一个参考图接口最多接收 64 张图片/
    );
});

test('legacy numbered reference inputs migrate in order and deduplicate the same source', () => {
    const migrated = migrateLegacyWorkflowData({
        nodes: [
            { id: 'image', type: 'ImageGenerate' },
            { id: 'video', type: 'VideoGenerate' },
            { id: 'a', type: 'ImageImport' },
            { id: 'b', type: 'ImageImport' }
        ],
        connections: [
            { id: 'i2', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'image', port: 'image_2' }, type: 'image' },
            { id: 'i1', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'image', port: 'image_1' }, type: 'image' },
            { id: 'dup', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'image', port: 'image_3' }, type: 'image' },
            { id: 'first', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'video', port: 'image_1' }, type: 'image' },
            { id: 'ref', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'video', port: 'image_3' }, type: 'image' }
        ]
    });

    assert.deepEqual(
        migrated.connections.filter((connection) => connection.to.nodeId === 'image').map((connection) => [connection.id, connection.to.port, connection.order]),
        [['i2', 'referenceImages', 1], ['i1', 'referenceImages', 0]]
    );
    assert.equal(migrated.connections.find((connection) => connection.id === 'first').to.port, 'image_1');
    assert.deepEqual(
        migrated.connections.find((connection) => connection.id === 'ref'),
        { id: 'ref', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'video', port: 'referenceImages' }, type: 'image', order: 0 }
    );
});

test('connection and execution contracts retain multiple reference image sources', () => {
    assert.match(connectionsSource, /const isMultiConnection = isMultiConnectionInput\(toNode\?\.type, toPort\)/);
    assert.match(connectionsSource, /if \(!isMultiConnection\) \{[\s\S]*?state\.connections = state\.connections\.filter/);
    assert.match(runnerSource, /isMultiConnectionInput\(node\?\.type, connection\.to\.port\)[\s\S]*?appendReferenceImages\([\s\S]*?outputValue/);
    assert.match(requestUtilsSource, /key === 'referenceImages'/);
    assert.match(requestUtilsSource, /return normalizeImageList\(inputs\.referenceImages\)/);
});

test('the obsolete port-count menu is replaced by disconnect-all', () => {
    assert.doesNotMatch(indexSource, /context-menu-reference-image-count/);
    assert.match(indexSource, /context-menu-disconnect-reference-images/);
    assert.match(contextMenuSource, /确认断开 \$\{referenceConnections\.length\} 条参考图连接/);
});
