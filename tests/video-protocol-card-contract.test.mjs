import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { VeoUnifiedProtocol } from '../js/features/execution/protocols/veo-unified.js';
import { VeoOpenAIProtocol } from '../js/features/execution/protocols/veo-openai.js';
import { DoubaoVideoProtocol } from '../js/features/execution/protocols/doubao-video.js';
import {
    describeVideoProtocolCard
} from '../js/nodes/video-protocol-card.js';
import {
    applyGenerationInputProjection,
    getProjectionImagePortIds,
    resolveGenerationInputProjection
} from '../js/nodes/generation-input-projection.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';
import { createClipboardControllerApi } from '../js/features/ui/clipboard-controller.js';
import { createNodeDomBindingsApi } from '../js/nodes/node-dom-bindings.js';
import { bindProtocolNumberStepControls } from '../js/nodes/protocol-event-binder.js';
import {
    activateProtocolVariantDraft,
    applyProtocolVariantSnapshot,
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

test('Protocol variant drafts restore prior values and only initialize newly declared defaults', () => {
    const kling = { seconds: { defaultValue: 3 }, size: { defaultValue: '960x1280' } };
    const minimax = { seconds: { defaultValue: 4 }, size: { defaultValue: '1440x1920' } };
    let data = activateProtocolVariantDraft({}, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: kling });
    data = saveProtocolVariantDraft(data, { seconds: 12, size: '960x1280' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'minimax-h3', parameters: minimax });
    assert.deepEqual(data.protocolParams, { seconds: 4, size: '1440x1920' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: { ...kling, loop: { defaultValue: false } } });
    assert.deepEqual(data.protocolParams, { seconds: 12, size: '960x1280', loop: false });
});

test('Protocol variant draft snapshots persist the authoritative active values without losing inactive variants', () => {
    const data = {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 3, size: '960x1280' },
            'async-video-api:minimax-h3': { seconds: 8, size: '1440x1920' }
        },
        protocolParams: { seconds: 3, size: '960x1280' }
    };

    assert.deepEqual(snapshotProtocolVariantDrafts(data), {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 3, size: '960x1280' },
            'async-video-api:minimax-h3': { seconds: 8, size: '1440x1920' }
        }
    });
});

test('Protocol variant draft writes immediately become the active persisted values', () => {
    const data = saveProtocolVariantDraft({
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: { 'async-video-api:minimax-h3': { seconds: 4 } },
        protocolParams: { seconds: 3 }
    }, { seconds: 12, size: '1280x960' });
    assert.deepEqual(snapshotProtocolVariantDrafts(data), {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:minimax-h3': { seconds: 4 },
            'async-video-api:kling-o3': { seconds: 12, size: '1280x960' }
        }
    });
});

test('variant snapshot application retains active and inactive drafts', () => {
    const serialized = { type: 'VideoGenerate' };
    applyProtocolVariantSnapshot(serialized, {
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 3 },
            'async-video-api:minimax-h3': { seconds: 8 }
        },
        protocolParams: { seconds: 12 }
    });
    assert.deepEqual(serialized, {
        type: 'VideoGenerate',
        protocolParams: { seconds: 12 },
        protocolVariantKey: 'async-video-api:kling-o3',
        protocolVariantDrafts: {
            'async-video-api:kling-o3': { seconds: 12 },
            'async-video-api:minimax-h3': { seconds: 8 }
        }
    });
});

test('workflow runtime snapshots persist active and inactive video Protocol variant drafts', () => {
    const documentRef = { getElementById: () => null, querySelectorAll: () => [] };
    const serialized = serializeRuntimeNode({
        id: 'video-runtime', type: 'VideoGenerate', x: 0, y: 0, enabled: true,
        data: {
            protocolVariantKey: 'async-video-api:kling-o3',
            protocolVariantDrafts: {
                'async-video-api:kling-o3': { seconds: 3 },
                'async-video-api:minimax-h3': { seconds: 8 }
            },
            protocolParams: { seconds: 12 }
        }
    }, documentRef);
    assert.equal(serialized.protocolVariantKey, 'async-video-api:kling-o3');
    assert.deepEqual(serialized.protocolVariantDrafts, {
        'async-video-api:kling-o3': { seconds: 12 },
        'async-video-api:minimax-h3': { seconds: 8 }
    });
});

test('workflow serialization persists active and inactive video Protocol variant drafts', () => {
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

test('workflow serialization reads image generation protocol parameters from its controls', () => {
    const protocolControl = { id: 'image-1-param-quality', value: 'high', type: 'select-one', tagName: 'SELECT' };
    const documentRef = {
        getElementById: (id) => ({
            'image-1-apiconfig': { value: 'model-config-1' },
            'image-1-provider': { value: 'provider-1' },
            'image-1-generation-count': { value: '1' }
        })[id] || null,
        querySelectorAll: (selector) => selector === '#image-1-param-quality-custom'
            ? []
            : (selector === '#image-1-protocol-params [id^="image-1-param-"]' ? [protocolControl] : [])
    };
    const serialized = serializeRuntimeNode({
        id: 'image-1', type: 'ImageGenerate', x: 0, y: 0, enabled: true,
        data: { protocolParams: { size: '1024x1024' } }
    }, documentRef);
    assert.deepEqual(serialized.protocolParams, { size: '1024x1024', quality: 'high' });
});

test('clipboard serialization persists active and inactive video Protocol variant drafts', () => {
    const state = {
        nodes: new Map([['video-copy', {
            id: 'video-copy', type: 'VideoGenerate', x: 0, y: 0, enabled: true,
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
    const documentRef = { getElementById: () => null, querySelectorAll: () => [] };
    const clipboard = createClipboardControllerApi({
        state,
        documentRef,
        showToast: () => {},
        addNode: () => null,
        updateAllConnections: () => {},
        updatePortStyles: () => {},
        scheduleSave: () => {}
    });
    const serialized = clipboard.serializeOneNode('video-copy');
    assert.deepEqual(serialized.protocolVariantDrafts, {
        'async-video-api:kling-o3': { seconds: 12 },
        'async-video-api:minimax-h3': { seconds: 8 }
    });
});

test('source video draft synchronization replaces a clone active and inactive drafts', () => {
    const cloneProtocolControl = { id: 'video-clone-param-seconds', value: '3', type: 'number', tagName: 'INPUT' };
    const emptyElement = {
        querySelectorAll: () => [],
        querySelector: () => null
    };
    const cloneElement = {
        querySelectorAll: () => [cloneProtocolControl],
        querySelector: () => null
    };
    const source = {
        id: 'video-source', type: 'VideoGenerate', isClone: false, el: emptyElement,
        data: {
            protocolVariantKey: 'async-video-api:kling-o3',
            protocolVariantDrafts: {
                'async-video-api:kling-o3': { seconds: 12 },
                'async-video-api:minimax-h3': { seconds: 8 }
            },
            protocolParams: { seconds: 12 }
        }
    };
    const clone = {
        id: 'video-clone', type: 'VideoGenerate', isClone: true, cloneSourceId: source.id, el: cloneElement,
        data: {
            protocolVariantKey: 'async-video-api:kling-o3',
            protocolVariantDrafts: {
                'async-video-api:kling-o3': { seconds: 3 },
                'async-video-api:minimax-h3': { seconds: 4 }
            },
            protocolParams: { seconds: 3 }
        }
    };
    const cloneModelControl = { value: 'clone-model' };
    const state = {
        nodes: new Map([[source.id, source], [clone.id, clone]]),
        connections: [],
        models: [{ id: 'clone-model', modelId: 'kling-o3', protocol: 'async-video-api' }],
        providers: []
    };
    createNodeDomBindingsApi({
        state,
        documentRef: {
            getElementById: (id) => id === 'video-clone-apiconfig'
                ? cloneModelControl
                : (id === 'video-clone-param-seconds' ? cloneProtocolControl : null)
        },
        debounce: (fn) => fn,
        scheduleSave: () => {},
        updateAllConnections: () => {}
    }).syncClonesFromSource(source.id);
    assert.deepEqual(clone.data.protocolVariantDrafts, source.data.protocolVariantDrafts);
    assert.deepEqual(clone.data.protocolParams, source.data.protocolParams);
});

test('built-in video protocols expose their declared card contracts without variants', () => {
    assert.equal(describeVideoProtocolCard(VeoUnifiedProtocol, 'veo-3').isDeclared, true);
    assert.equal(describeVideoProtocolCard(DoubaoVideoProtocol, 'seedance').isDeclared, true);
});

test('built-in video card input ports come only from each protocol declaration', () => {
    const frameAndReferencePorts = ['image_1', 'image_2', 'referenceImages'];
    const ports = (protocol, modelId) => getProjectionImagePortIds(resolveGenerationInputProjection({ protocol, modelId, taskType: 'video' }));
    assert.deepEqual(ports(VeoUnifiedProtocol, 'veo-3'), frameAndReferencePorts);
    assert.deepEqual(ports(VeoOpenAIProtocol, 'sora'), frameAndReferencePorts);
    assert.deepEqual(ports(DoubaoVideoProtocol, 'seedance'), frameAndReferencePorts);
    assert.deepEqual(ports(RelayVideoProtocol, 'kling-o3'), ['referenceImages']);
    assert.deepEqual(ports(RelayVideoProtocol, 'minimax-h3'), ['referenceImages']);
    assert.deepEqual(ports({ id: 'user-video', parameters: {} }, 'custom'), []);
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

    applyGenerationInputProjection(root, resolveGenerationInputProjection({
        protocol: RelayVideoProtocol, modelId: 'minimax-h3', taskType: 'video'
    }));
    assert.deepEqual(ports.map((port) => port.hidden), [true, true, false]);
    assert.equal(ports[2].dataset.multiple, undefined);
    assert.equal(ports[2].dataset.baseLabel, '参考图');

    applyGenerationInputProjection(root, resolveGenerationInputProjection({
        protocol: VeoUnifiedProtocol, modelId: 'veo-3', taskType: 'video'
    }));
    assert.deepEqual(ports.map((port) => port.hidden), [false, false, false]);
    assert.equal(ports[2].dataset.multiple, 'true');
    assert.equal(ports[2].dataset.baseLabel, '参考图 {index}');
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

test('video protocol duration step buttons update their rendered numeric input', () => {
    const listeners = new Map();
    let inputEvents = 0;
    const input = {
        id: 'video-1-param-duration', value: '5',
        getAttribute(name) { return ({ 'data-min': '4', 'data-max': '12' })[name] ?? null; },
        addEventListener(type, listener) {
            if (type === 'input') {
                listeners.set(type, () => { inputEvents += 1; listener(); });
            } else {
                listeners.set(type, listener);
            }
        },
        dispatchEvent(event) { listeners.get(event.type)?.(event); return true; }
    };
    const button = {
        getAttribute(name) { return ({ 'data-target': input.id, 'data-step': '1' })[name] ?? null; },
        addEventListener(type, listener) { listeners.set(`button:${type}`, listener); }
    };
    const documentRef = {
        getElementById: (id) => id === input.id ? input : null,
        querySelectorAll: () => [button]
    };
    const root = { querySelectorAll: (selector) => selector === '.number-step' ? [button] : [input] };

    bindProtocolNumberStepControls(root, documentRef);
    listeners.get('button:click')();

    assert.equal(input.value, 6);
    assert.equal(inputEvents, 1);
});
