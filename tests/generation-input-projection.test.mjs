import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getInactiveProjectedInputPorts,
    getGenerationNodeInputConnectionPolicy,
    getProjectedInputValidationReason,
    getProjectedInputConnectionPolicy,
    getProjectionImagePortIds,
    resolveGenerationInputProjection,
    validateProjectedInputConnections
} from '../js/nodes/generation-input-projection.js';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { VeoUnifiedProtocol } from '../js/features/execution/protocols/veo-unified.js';
import { VeoOpenAIProtocol } from '../js/features/execution/protocols/veo-openai.js';
import { DoubaoVideoProtocol } from '../js/features/execution/protocols/doubao-video.js';
import { getGenerationInputProtocolId } from '../js/features/execution/provider-request-utils.js';
import { createConnectionsApi } from '../js/canvas/connections.js';

test('generation input projection exposes the built-in VEO input contract', () => {
    const projection = resolveGenerationInputProjection({
        protocol: VeoUnifiedProtocol, modelId: 'veo-3', taskType: 'video'
    });

    assert.equal(projection.blockedReason, '');
    assert.deepEqual(getProjectionImagePortIds(projection), ['image_1', 'image_2', 'referenceImages']);
    assert.deepEqual(projection.promptPortIds, ['prompt']);
    assert.deepEqual(
        projection.ports.find((port) => port.id === 'referenceImages'),
        { id: 'referenceImages', type: 'image', label: '参考图 {index}', multiple: true, maxCount: 5, required: false }
    );
});

test('generation input projection honors exact variant limits and preserves inactive connections', () => {
    const projection = resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'minimax-h3', taskType: 'video'
    });

    assert.deepEqual(getProjectionImagePortIds(projection), ['referenceImages']);
    assert.equal(projection.ports.find((port) => port.id === 'referenceImages').multiple, false);
    assert.deepEqual(getInactiveProjectedInputPorts(projection, [
        { to: { port: 'image_1' } },
        { to: { port: 'referenceImages' } },
        { to: { port: 'image_2' } }
    ]), ['image_1', 'image_2']);
});

test('generation input projection blocks unmatched and unsupported protocol inputs safely', () => {
    assert.match(
        resolveGenerationInputProjection({ protocol: RelayVideoProtocol, modelId: 'missing', taskType: 'video' }).blockedReason,
        /未配置此模型变体/
    );
    assert.match(
        resolveGenerationInputProjection({
            protocol: { id: 'custom', parameters: { audio: { id: 'audio', inputPort: true, portType: 'audio' } } },
            modelId: 'custom', taskType: 'video'
        }).blockedReason,
        /不支持的输入类型：audio/
    );
});

test('declared image port count controls connection multiplicity without relying on its name', () => {
    const projection = resolveGenerationInputProjection({
        protocol: {
            id: 'storyboard-video',
            parameters: {
                storyboardFrames: {
                    id: 'storyboardFrames', inputPort: true, portType: 'image',
                    portCount: 3, portLabel: '分镜 {index}', taskTypes: ['video']
                }
            }
        },
        modelId: 'storyboard-model', taskType: 'video'
    });

    assert.deepEqual(getProjectedInputConnectionPolicy(projection, 'storyboardFrames'), {
        supported: true, multiple: true, maxCount: 3
    });
});

test('projected input validation rejects excess connections without dropping them', () => {
    const projection = resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'minimax-h3', taskType: 'video'
    });
    const connections = [
        { id: 'first', to: { port: 'referenceImages' } },
        { id: 'second', to: { port: 'referenceImages' } }
    ];

    assert.deepEqual(validateProjectedInputConnections(projection, connections), {
        valid: false,
        inactivePorts: [],
        violations: [{ portId: 'referenceImages', maxCount: 1, actualCount: 2 }]
    });
    assert.equal(connections.length, 2);
});

test('video node connection policy comes from its active generation input projection', () => {
    const projection = resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'kling-o3', taskType: 'video'
    });
    const node = { type: 'VideoGenerate', generationInputProjection: projection };

    assert.deepEqual(getGenerationNodeInputConnectionPolicy(node, 'referenceImages'), {
        supported: true, multiple: true, maxCount: 5
    });
    assert.deepEqual(getGenerationNodeInputConnectionPolicy(node, 'image_1'), {
        supported: false, multiple: false, maxCount: 0
    });
});

test('generation input protocol identity does not change with provider selection', () => {
    const model = { modelId: 'veo-3', protocol: 'veo-unified', taskType: 'video' };
    assert.equal(getGenerationInputProtocolId(model), 'veo-unified');
    assert.equal(getGenerationInputProtocolId({ ...model, providerId: 'provider-b' }), 'veo-unified');
});

test('every built-in video protocol keeps its declared generation input contract', () => {
    const cases = [
        [VeoUnifiedProtocol, 'veo-3', ['image_1', 'image_2', 'referenceImages'], 5],
        [VeoOpenAIProtocol, 'sora', ['image_1', 'image_2', 'referenceImages'], 5],
        [DoubaoVideoProtocol, 'seedance', ['image_1', 'image_2', 'referenceImages'], 5],
        [RelayVideoProtocol, 'kling-o3', ['referenceImages'], 5],
        [RelayVideoProtocol, 'minimax-h3', ['referenceImages'], 1]
    ];

    cases.forEach(([protocol, modelId, imagePortIds, maximumReferenceImages]) => {
        const projection = resolveGenerationInputProjection({ protocol, modelId, taskType: 'video' });
        assert.equal(projection.blockedReason, '', `${protocol.id}:${modelId}`);
        assert.deepEqual(getProjectionImagePortIds(projection), imagePortIds, `${protocol.id}:${modelId}`);
        assert.deepEqual(projection.promptPortIds, ['prompt'], `${protocol.id}:${modelId}`);
        assert.equal(
            getProjectedInputConnectionPolicy(projection, 'referenceImages').maxCount,
            maximumReferenceImages,
            `${protocol.id}:${modelId}`
        );
    });
});

test('creating a connection cannot exceed the active video projection limit', () => {
    const projection = resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'kling-o3', taskType: 'video'
    });
    const classList = { contains: () => false };
    const nodes = new Map([
        ['source', { type: 'ImageImport', el: { classList } }],
        ['target', { type: 'VideoGenerate', generationInputProjection: projection, el: { classList } }]
    ]);
    const state = {
        canvas: { x: 0, y: 0, zoom: 1 },
        connections: Array.from({ length: 5 }, (_, order) => ({
            id: `existing-${order}`,
            from: { nodeId: `source-${order}`, port: 'image' },
            to: { nodeId: 'target', port: 'referenceImages' },
            type: 'image', order
        })),
        nodes,
        runningNodeIds: new Set()
    };
    const messages = [];
    const api = createConnectionsApi({
        state,
        canvasContainer: {}, connectionsGroup: {}, tempConnection: {}, originAxes: null,
        getNodeById: (id) => nodes.get(id),
        createBezierPath: () => '', getConnectionSamplePoints: () => [], pushHistory() {},
        showToast: (message) => messages.push(message), scheduleSave() {},
        documentRef: { defaultView: {}, querySelectorAll: () => [] },
        connectionRenderer: { enabled: false, begin() {}, end() {}, clear() {} }
    });

    api.finishConnection(
        { nodeId: 'source', portName: 'image', dataType: 'image', isOutput: true },
        { nodeId: 'target', port: 'referenceImages', type: 'image', dir: 'input' }
    );

    assert.equal(state.connections.length, 5);
    assert.deepEqual(messages, ['此输入端口最多连接 5 张图片']);
});

test('generation input validation explains inactive and excess connections before execution', () => {
    const projection = resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'minimax-h3', taskType: 'video'
    });
    assert.equal(
        getProjectedInputValidationReason(projection, [{ to: { port: 'image_1' } }]),
        '当前模型不支持已连接的输入：image_1。请断开连接或切换回兼容模型。'
    );
    assert.equal(
        getProjectedInputValidationReason(projection, [
            { to: { port: 'referenceImages' } },
            { to: { port: 'referenceImages' } }
        ]),
        '输入 referenceImages 最多允许 1 条连接，当前有 2 条。请断开多余连接。'
    );
});
