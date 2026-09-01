import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { VeoUnifiedProtocol } from '../js/features/execution/protocols/veo-unified.js';
import { VeoOpenAIProtocol } from '../js/features/execution/protocols/veo-openai.js';
import { DoubaoVideoProtocol } from '../js/features/execution/protocols/doubao-video.js';
import {
    describeVideoProtocolCard,
    getVideoProtocolInputPorts,
    updateVideoProtocolInputPortVisibility
} from '../js/nodes/video-protocol-card.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import {
    activateProtocolVariantDraft,
    saveProtocolVariantDraft,
    snapshotProtocolVariantDrafts
} from '../js/nodes/protocol-variant-drafts.js';

test('Kling card contract exposes the exact variant identity and constraints', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'kling-o3'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: false,
        summary: '6789中转视频 · kling-o3 · 时长 3–15 秒 · 最多 5 张参考图'
    });
});

test('MiniMax card contract retains its own exact limits', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'minimax-h3'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: false,
        summary: '6789中转视频 · minimax-h3 · 时长 4–15 秒 · 最多 1 张参考图'
    });
});

test('an unmatched declared video variant enters a safe card state', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'unknown-video'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: true,
        summary: '6789中转视频 · unknown-video · 未配置变体'
    });
});

test('variant drafts restore prior values and only initialize newly declared defaults', () => {
    const kling = { seconds: { defaultValue: 3 }, size: { defaultValue: '960x1280' } };
    const minimax = { seconds: { defaultValue: 4 }, size: { defaultValue: '1440x1920' } };
    let data = activateProtocolVariantDraft({}, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: kling });
    data = saveProtocolVariantDraft(data, { seconds: 12, size: '960x1280' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'minimax-h3', parameters: minimax });
    assert.deepEqual(data.protocolParams, { seconds: 4, size: '1440x1920' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: { ...kling, loop: { defaultValue: false } } });
    assert.deepEqual(data.protocolParams, { seconds: 12, size: '960x1280', loop: false });
});

test('variant draft snapshots persist the active form values without losing inactive variants', () => {
    const data = {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 3, size: '960x1280' },
            'async-video-api:minimax-h3': { seconds: 8, size: '1440x1920' }
        },
        protocolParams: { seconds: 3, size: '960x1280' }
    };

    assert.deepEqual(snapshotProtocolVariantDrafts(data, { seconds: 12, size: '1280x960' }), {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 12, size: '1280x960' },
            'async-video-api:minimax-h3': { seconds: 8, size: '1440x1920' }
        }
    });
});

test('workflow serialization persists active and inactive video variant drafts', () => {
    const controls = new Map([
        ['video-1-apiconfig', { value: 'model-config-1' }],
        ['video-1-provider', { value: 'provider-1' }],
        ['video-1-generation-count', { value: '1' }]
    ]);
    const documentRef = {
        getElementById: (id) => controls.get(id) || null,
        querySelectorAll: () => []
    };
    const state = {
        nodes: new Map([['video-1', {
            type: 'VideoGenerate', x: 10, y: 20, enabled: true,
            data: {
                protocolVariantKey: 'async-video-api:kling-o3',
                protocolVariantDrafts: {
                    'async-video-api:kling-o3': { seconds: 3 },
                    'async-video-api:minimax-h3': { seconds: 8 }
                },
                protocolParams: { seconds: 12 }
            }
        }]]),
        connections: []
    };

    const [serialized] = createNodeSerializer({ state, documentRef }).serializeNodes();
    assert.equal(serialized.protocolVariantKey, 'async-video-api:kling-o3');
    assert.deepEqual(serialized.protocolVariantDrafts, {
        'async-video-api:kling-o3': { seconds: 12 },
        'async-video-api:minimax-h3': { seconds: 8 }
    });
});

test('built-in video protocols expose their declared card contracts without variants', () => {
    assert.equal(describeVideoProtocolCard(VeoUnifiedProtocol, 'veo-3').isDeclared, true);
    assert.equal(describeVideoProtocolCard(DoubaoVideoProtocol, 'seedance').isDeclared, true);
});

test('built-in video card input ports come only from each protocol declaration', () => {
    const frameAndReferencePorts = ['image_1', 'image_2', 'referenceImages'];
    assert.deepEqual(getVideoProtocolInputPorts(VeoUnifiedProtocol, 'veo-3'), frameAndReferencePorts);
    assert.deepEqual(getVideoProtocolInputPorts(VeoOpenAIProtocol, 'sora'), frameAndReferencePorts);
    assert.deepEqual(getVideoProtocolInputPorts(DoubaoVideoProtocol, 'seedance'), frameAndReferencePorts);
    assert.deepEqual(getVideoProtocolInputPorts(RelayVideoProtocol, 'kling-o3'), ['referenceImages']);
    assert.deepEqual(getVideoProtocolInputPorts(RelayVideoProtocol, 'minimax-h3'), ['referenceImages']);
    assert.deepEqual(getVideoProtocolInputPorts({ id: 'user-video', parameters: {} }, 'custom'), []);
});

test('declared video input ports drive the rendered card visibility and multiplicity', () => {
    const createPort = (name) => ({
        dataset: { port: name, type: 'image', multiple: 'true' },
        hidden: false,
        classList: { toggle(_name, hidden) { this.owner.hidden = hidden; }, owner: null },
        removeAttribute(attribute) { if (attribute === 'data-multiple') delete this.dataset.multiple; }
    });
    const ports = ['image_1', 'image_2', 'referenceImages'].map(createPort);
    ports.forEach((port) => { port.classList.owner = port; });
    const root = {
        querySelectorAll: () => ports,
        querySelector: () => ports[2]
    };

    updateVideoProtocolInputPortVisibility(
        root,
        getVideoProtocolInputPorts(RelayVideoProtocol, 'minimax-h3'),
        RelayVideoProtocol.variants['minimax-h3']
    );
    assert.deepEqual(ports.map((port) => port.hidden), [true, true, false]);
    assert.equal(ports[2].dataset.multiple, undefined);
    assert.equal(ports[2].dataset.baseLabel, '参考图');

    updateVideoProtocolInputPortVisibility(root, getVideoProtocolInputPorts(VeoUnifiedProtocol, 'veo-3'));
    assert.deepEqual(ports.map((port) => port.hidden), [false, false, false]);
    assert.equal(ports[2].dataset.multiple, 'true');
});

test('built-in video parameters remain declaration-owned after the legacy control migration', () => {
    const parameters = VeoUnifiedProtocol.parameters;
    assert.equal(parameters.aspect_ratio.exposed, true);
    assert.equal(parameters.duration.exposed, true);
    assert.equal(DoubaoVideoProtocol.parameters.resolution.exposed, true);
    assert.equal(DoubaoVideoProtocol.parameters.camera_fixed.exposed, true);
});

test('a user-owned video protocol without editable parameters has a safe card error', () => {
    assert.deepEqual(describeVideoProtocolCard({ id: 'user-video', label: 'User video', parameters: {} }, 'model-a'), {
        isDeclared: false,
        isIncomplete: true,
        isUnmatched: false,
        summary: 'User video · model-a · 未声明可编辑视频参数'
    });
});
