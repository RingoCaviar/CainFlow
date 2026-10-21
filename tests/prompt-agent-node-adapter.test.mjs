import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentNodeAdapter, getAvailablePromptAgentImageModels } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';

function control(value = '') {
    return {
        value,
        dispatches: [],
        dispatchEvent(event) { this.dispatches.push(event.type); }
    };
}

function harness({ selected = ['image-1'], nodeType = 'ImageGenerate' } = {}) {
    const controls = {
        'image-1-prompt': control('原始提示词'),
        'image-1-param-negative_prompt': control('原始负面提示词'),
        'image-1-aspect': control('1:1'),
        'image-1-resolution': control('1024x1024'),
        'image-1-generation-count': control('1')
    };
    const node = { id: 'image-1', type: nodeType, data: { prompt: '数据提示词', protocolParams: {} } };
    const source = { id: 'source-1', type: 'ImageImport', data: { imageAssetKey: 'media:reference-1', image: 'data:image/png;base64,cmVm' } };
    const state = {
        selectedNodes: new Set(selected),
        nodes: new Map([['image-1', node], ['source-1', source]]),
        connections: [{ from: { nodeId: 'source-1', port: 'image' }, to: { nodeId: 'image-1', port: 'image_1' } }]
    };
    let saves = 0;
    const adapter = createPromptAgentNodeAdapter({
        state,
        documentRef: { getElementById: (id) => controls[id] || null },
        scheduleSave: () => { saves += 1; },
        createEvent: (type) => ({ type })
    });
    return { adapter, controls, node, state, getSaves: () => saves };
}

test('reads one explicitly selected image-generation node as Agent context', () => {
    const { adapter } = harness();

    assert.deepEqual(adapter.getSelectedContext(), {
        nodeId: 'image-1',
        prompt: '原始提示词',
        negativePrompt: '原始负面提示词',
        parameterSchema: {
            aspectRatio: { type: 'string' }, resolution: { type: 'string' }, count: { type: 'integer', minimum: 1 }
        },
        model: null,
        parameters: {
            aspectRatio: '1:1', resolution: '1024x1024', customWidth: '', customHeight: '',
            quality: '', moderation: '', background: '', search: false, count: 1, protocolParams: {}
        },
        referenceImages: [{
            sourceNodeId: 'source-1', sourcePort: 'image', targetPort: 'image_1',
            assetKeys: ['media:reference-1'], images: ['data:image/png;base64,cmVm']
        }],
        outputImages: []
    });
});

test('does not guess a target when selection is missing, multiple, or not image generation', () => {
    assert.equal(harness({ selected: [] }).adapter.getSelectedContext(), null);
    assert.equal(harness({ selected: ['image-1', 'other'] }).adapter.getSelectedContext(), null);
    assert.equal(harness({ nodeType: 'TextChat' }).adapter.getSelectedContext(), null);
});

test('applies a Prompt Plan to its bound image-generation node without requiring selection', () => {
    const { adapter, controls, node, getSaves } = harness({ selected: [] });
    const applied = adapter.applyPromptPlan({
        targetNodeId: 'image-1',
        prompt: '电影感城市夜景',
        negativePrompt: '卡通、过度饱和',
        parameters: { aspectRatio: '16:9', resolution: '2048x1152', count: 2 }
    });

    assert.equal(applied, true);
    assert.equal(controls['image-1-prompt'].value, '电影感城市夜景');
    assert.equal(controls['image-1-param-negative_prompt'].value, '卡通、过度饱和');
    assert.equal(controls['image-1-aspect'].value, '16:9');
    assert.equal(controls['image-1-resolution'].value, '2K');
    assert.equal(controls['image-1-generation-count'].value, '2');
    assert.equal(node.data.prompt, '电影感城市夜景');
    assert.equal(node.data.protocolParams.negative_prompt, '卡通、过度饱和');
    assert.equal(getSaves(), 1);
});

test('selection changes do not retarget bound plans or hide their context', () => {
    const { adapter, state, node } = harness();
    const other = { id: 'image-2', type: 'ImageGenerate', data: { prompt: '保持不变' } };
    state.nodes.set(other.id, other);
    state.selectedNodes = new Set([other.id]);
    state.models = [{ id: 'image-model', modelId: 'image-test', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }];
    state.providers = [{ id: 'provider', endpoint: 'https://example.test' }];
    const plan = { targetNodeId: node.id, prompt: '修改原目标', parameters: {} };
    assert.equal(adapter.getContext(node.id).nodeId, node.id);
    assert.equal(adapter.getSelectedContext().nodeId, other.id);
    assert.deepEqual(adapter.ensureTarget(plan, { modelId: 'image-model' }), plan);
    assert.equal(adapter.applyPromptPlan(plan), true);
    assert.equal(node.data.prompt, plan.prompt);
    assert.equal(other.data.prompt, '保持不变');
});

function creationHarness({ models, providers, selected = [] } = {}) {
    const provider = { id: 'provider-1', endpoint: 'https://example.test/v1' };
    const model = { id: 'image-model', modelId: 'gpt-image-test', taskType: 'image', protocol: 'openai', providerIds: [provider.id] };
    const state = {
        nodes: new Map(), selectedNodes: new Set(selected), connections: [],
        models: models ?? [model], providers: providers ?? [provider]
    };
    const creations = [];
    const adapter = createPromptAgentNodeAdapter({
        state, documentRef: { getElementById: () => null },
        createImageNode: (configuration) => {
            creations.push(configuration);
            const id = `created-${creations.length}`;
            state.nodes.set(id, { id, type: 'ImageGenerate', apiConfigId: configuration.model.id, data: { prompt: configuration.prompt } });
            return id;
        }
    });
    return { adapter, creations, state, model, provider };
}

test('unassigned plans create one configured image node and bound retries reuse it', () => {
    const { adapter, creations, state, model, provider } = creationHarness();
    const draft = { targetNodeId: null, prompt: '橘猫晒太阳', parameters: {} };
    const bound = adapter.ensureTarget(draft, { modelId: model.id });
    assert.equal(bound.targetNodeId, 'created-1');
    assert.equal(draft.targetNodeId, null);
    assert.deepEqual(creations, [{ model, provider, prompt: draft.prompt }]);
    assert.equal(state.selectedNodes.size, 0);
    assert.deepEqual(adapter.ensureTarget(bound, { modelId: model.id }), bound);
    assert.equal(creations.length, 1);
    assert.equal(adapter.applyPromptPlan(bound), true);
});

test('unassigned plans create their own node even if another node was selected after drafting', () => {
    const { adapter, state, creations } = creationHarness({ selected: ['existing'] });
    state.nodes.set('existing', { id: 'existing', type: 'ImageGenerate', data: { prompt: '原提示词' } });
    const bound = adapter.ensureTarget({ prompt: '新草稿', parameters: {} }, { modelId: 'image-model' });
    assert.equal(bound.targetNodeId, 'created-1');
    assert.equal(creations.length, 1);
    assert.equal(state.nodes.get('existing').data.prompt, '原提示词');
});

test('removed or replaced targets are rejected without creating or retargeting a node', () => {
    const { adapter, state, creations } = creationHarness();
    const bound = adapter.ensureTarget({ prompt: '草稿', parameters: {} }, { modelId: 'image-model' });
    state.nodes.delete(bound.targetNodeId);
    assert.throws(() => adapter.ensureTarget(bound), /目标生图节点已不存在/);
    assert.equal(adapter.getContext(bound.targetNodeId), null);
    assert.equal(adapter.applyPromptPlan(bound), false);
    state.nodes.set(bound.targetNodeId, { id: bound.targetNodeId, type: 'TextChat', data: {} });
    assert.throws(() => adapter.ensureTarget(bound), /目标生图节点已不存在/);
    assert.equal(adapter.getContext(bound.targetNodeId), null);
    assert.equal(creations.length, 1);
});

test('image-model choices filter unusable configurations and creation uses the exact explicit model', () => {
    const providers = [
        { id: 'blank', endpoint: '   ' }, { id: 'second', endpoint: 'https://second.test' },
        { id: 'preferred', endpoint: 'https://preferred.test' }
    ];
    const base = { modelId: 'image-test', taskType: 'image', protocol: 'openai', providerIds: ['blank', 'preferred', 'second'] };
    const models = [
        { ...base, id: 'chat', taskType: 'chat' }, { ...base, id: 'unknown', protocol: '' },
        { ...base, id: 'video-format', protocol: 'async-video-api' },
        { ...base, id: 'orphan', providerIds: ['missing'] },
        { ...base, id: 'valid' }, { ...base, id: 'later' }
    ];
    const { adapter, creations } = creationHarness({ models, providers });
    assert.deepEqual(getAvailablePromptAgentImageModels(models, providers).map((model) => model.id), ['valid', 'later']);
    adapter.ensureTarget({ prompt: '草稿', parameters: {} }, { modelId: 'later' });
    assert.equal(creations[0].model.id, 'later');
    assert.equal(creations[0].provider.id, 'preferred');
});

test('missing image configuration or an empty draft never creates a node', () => {
    for (const options of [{ models: [] }, { providers: [] }, { providers: [{ id: 'provider-1', endpoint: ' ' }] }]) {
        const { adapter, creations } = creationHarness(options);
        assert.throws(() => adapter.ensureTarget({ prompt: '草稿', parameters: {} }, { modelId: 'image-model' }), /生图模型已不可用/);
        assert.equal(creations.length, 0);
    }
    const { adapter, creations } = creationHarness();
    assert.throws(() => adapter.ensureTarget({ prompt: ' ', parameters: {} }), /提示词/);
    assert.equal(creations.length, 0);
});

test('empty, unknown and removed model choices never fall back or create a node', () => {
    const { adapter, creations, state } = creationHarness();
    const plan = { prompt: '草稿', parameters: {} };
    assert.throws(() => adapter.ensureTarget(plan), /选择生图模型/);
    assert.throws(() => adapter.ensureTarget(plan, { modelId: '' }), /选择生图模型/);
    assert.throws(() => adapter.ensureTarget(plan, { modelId: 'removed' }), /生图模型已不可用/);
    state.models = [];
    assert.throws(() => adapter.ensureTarget(plan, { modelId: 'image-model' }), /生图模型已不可用/);
    assert.equal(creations.length, 0);
});

function configuredNodeHarness() {
    const result = harness();
    result.state.models = [
        { id: 'first', modelId: 'first-image', taskType: 'image', protocol: 'openai', providerIds: ['provider-1', 'provider-2'] },
        { id: 'second', modelId: 'second-image', taskType: 'image', protocol: 'google', providerIds: ['provider-3', 'provider-2'] }
    ];
    result.state.providers = [1, 2, 3].map((index) => ({ id: `provider-${index}`, endpoint: `https://provider${index}.test` }));
    result.controls['image-1-apiconfig'] = control('first');
    result.controls['image-1-provider'] = control('provider-2');
    result.node.apiConfigId = 'first';
    result.node.providerId = 'provider-2';
    return result;
}

test('bound nodes require a valid explicit choice even when their DOM has fallen back to a valid model', () => {
    const { adapter, node, controls, state, getSaves } = configuredNodeHarness();
    const plan = { targetNodeId: node.id, prompt: '新方案', parameters: {} };
    assert.throws(() => adapter.ensureTarget(plan), /选择生图模型/);
    assert.throws(() => adapter.ensureTarget(plan, { modelId: 'missing' }), /生图模型已不可用/);
    node.apiConfigId = 'second';
    state.models = state.models.filter((model) => model.id !== 'second');
    assert.throws(() => adapter.ensureTarget(plan, { modelId: 'second' }), /生图模型已不可用/);
    assert.equal(node.apiConfigId, 'second');
    assert.equal(controls['image-1-apiconfig'].value, 'first');
    assert.equal(node.data.prompt, '数据提示词');
    assert.equal(getSaves(), 0);
});

test('an explicit choice switches the bound node through model and provider change handlers', () => {
    const { adapter, node, controls, getSaves } = configuredNodeHarness();
    const changes = [];
    for (const suffix of ['apiconfig', 'provider']) {
        const input = controls[`image-1-${suffix}`];
        input.dispatchEvent = (event) => { if (event.type === 'change') changes.push([suffix, input.value]); };
    }
    const plan = { targetNodeId: node.id, prompt: '新方案', parameters: {} };
    assert.equal(adapter.ensureTarget(plan, { modelId: 'second' }), plan);
    assert.deepEqual(changes, [['apiconfig', 'second'], ['provider', 'provider-3']]);
    assert.equal(node.apiConfigId, 'second');
    assert.equal(node.data.apiConfigId, 'second');
    assert.equal(node.providerId, 'provider-3');
    assert.equal(node.data.providerId, 'provider-3');
    assert.equal(node.data.prompt, '数据提示词');
    assert.equal(getSaves(), 1);
});

test('an explicit valid model overrides a stale dropdown fallback and follows the new model provider priority', () => {
    const { adapter, node, controls } = configuredNodeHarness();
    node.apiConfigId = 'second';
    // The model settings refresh has implicitly moved the DOM to "first".
    // Explicitly choosing it in Agent must still configure that exact model.
    const plan = { targetNodeId: node.id, prompt: '新方案', parameters: {} };
    adapter.ensureTarget(plan, { modelId: 'first' });
    assert.equal(node.apiConfigId, 'first');
    assert.equal(node.providerId, 'provider-1');
    assert.equal(controls['image-1-provider'].value, 'provider-1');
    assert.deepEqual(controls['image-1-apiconfig'].dispatches, ['input', 'change']);
});

test('the same model retains its usable provider and replaces an unavailable provider by priority', () => {
    const { adapter, node, state, controls } = configuredNodeHarness();
    const plan = { targetNodeId: node.id, prompt: '新方案', parameters: {} };
    adapter.ensureTarget(plan, { modelId: 'first' });
    assert.equal(node.providerId, 'provider-2');
    assert.deepEqual(controls['image-1-apiconfig'].dispatches, []);
    assert.deepEqual(controls['image-1-provider'].dispatches, []);
    state.providers.find((provider) => provider.id === 'provider-2').endpoint = '';
    adapter.ensureTarget(plan, { modelId: 'first' });
    assert.equal(node.providerId, 'provider-1');
    assert.equal(controls['image-1-provider'].value, 'provider-1');
});

test('model changes rebuild parameter controls before application and incompatible plans keep their target', () => {
    const { adapter, node, controls } = configuredNodeHarness();
    controls['image-1-aspect'].options = [{ value: '1:1' }, { value: '16:9' }];
    controls['image-1-apiconfig'].dispatchEvent = (event) => {
        if (event.type === 'change') controls['image-1-aspect'].options = [{ value: '1:1' }];
    };
    const plan = { targetNodeId: node.id, prompt: '不得部分应用', parameters: { aspectRatio: '16:9' } };
    const bound = adapter.ensureTarget(plan, { modelId: 'second' });
    assert.equal(bound.targetNodeId, node.id);
    assert.equal(adapter.applyPromptPlan(bound), false);
    assert.equal(node.data.prompt, '数据提示词');
    assert.equal(controls['image-1-prompt'].value, '原始提示词');
    assert.equal(node.apiConfigId, 'second');

    const created = creationHarness();
    const newBound = created.adapter.ensureTarget({ prompt: '新图', parameters: { unsupported: true } }, { modelId: 'image-model' });
    assert.equal(newBound.targetNodeId, 'created-1');
    assert.equal(created.adapter.applyPromptPlan(newBound), false);
    assert.equal(created.adapter.ensureTarget(newBound, { modelId: 'image-model' }).targetNodeId, 'created-1');
    assert.equal(created.creations.length, 1);
});

test('running targets reject preparation and application without changing model, provider or prompt', () => {
    for (const marker of ['state', 'element']) {
        const { adapter, node, state, controls, getSaves } = configuredNodeHarness();
        if (marker === 'state') state.runningNodeIds = new Set([node.id]);
        else node.el = { classList: { contains: (name) => name === 'running' } };
        const plan = { targetNodeId: node.id, prompt: '不得修改', parameters: {} };
        assert.throws(() => adapter.ensureTarget(plan, { modelId: 'second' }), /节点正在运行/);
        assert.equal(adapter.applyPromptPlan(plan), false);
        assert.equal(node.apiConfigId, 'first');
        assert.equal(node.providerId, 'provider-2');
        assert.equal(node.data.prompt, '数据提示词');
        assert.equal(controls['image-1-apiconfig'].value, 'first');
        assert.equal(getSaves(), 0);
    }
});

test('workflow startup blocks new targets and bound mutations until the execution snapshot is ready', () => {
    const { adapter, node, state, controls, getSaves } = configuredNodeHarness();
    const plan = { targetNodeId: node.id, prompt: '启动后才应用', parameters: {} };
    state.isRunStarting = true;
    assert.throws(() => adapter.ensureTarget(plan, { modelId: 'second' }), /工作流正在启动/);
    assert.equal(adapter.applyPromptPlan(plan), false);
    assert.equal(node.apiConfigId, 'first');
    assert.equal(node.providerId, 'provider-2');
    assert.equal(node.data.prompt, '数据提示词');
    assert.deepEqual(controls['image-1-apiconfig'].dispatches, []);
    assert.deepEqual(controls['image-1-provider'].dispatches, []);
    assert.equal(getSaves(), 0);
    state.isRunStarting = false;
    assert.equal(adapter.ensureTarget(plan, { modelId: 'second' }), plan);
    assert.equal(adapter.applyPromptPlan(plan), true);
    assert.equal(node.apiConfigId, 'second');
    assert.equal(node.data.prompt, plan.prompt);

    const created = creationHarness();
    const draft = { prompt: '等启动完成后创建', parameters: {} };
    created.state.isRunStarting = true;
    assert.throws(() => created.adapter.ensureTarget(draft, { modelId: 'image-model' }), /工作流正在启动/);
    assert.equal(created.adapter.applyPromptPlan(draft), false);
    assert.equal(created.creations.length, 0);
    assert.equal(created.state.nodes.size, 0);
    created.state.isRunStarting = false;
    const bound = created.adapter.ensureTarget(draft, { modelId: 'image-model' });
    assert.equal(created.creations.length, 1);
    assert.equal(created.adapter.applyPromptPlan(bound), true);
});

test('a ratio-only Prompt Plan selects a resolution tier so the ratio reaches OpenAI', () => {
    const { adapter, controls } = harness();
    controls['image-1-resolution'].value = '';
    assert.equal(adapter.applyPromptPlan({
        targetNodeId: 'image-1', prompt: '横幅', parameters: { aspectRatio: '16:9' }
    }), true);
    assert.equal(controls['image-1-resolution'].value, '1K');
    assert.equal(controls['image-1-aspect'].value, '16:9');
});

test('text-only refinement preserves the existing negative prompt and node parameters', () => {
    const { adapter, controls, node } = harness();
    node.data.protocolParams = { negative_prompt: '不要改变文字', seed: 42 };
    assert.equal(adapter.applyPromptPlan({ targetNodeId: 'image-1', prompt: '仅调整光线', parameters: {} }), true);
    assert.equal(controls['image-1-param-negative_prompt'].value, '原始负面提示词');
    assert.equal(controls['image-1-aspect'].value, '1:1');
    assert.equal(controls['image-1-resolution'].value, '1024x1024');
    assert.deepEqual(node.data.protocolParams, { negative_prompt: '不要改变文字', seed: 42 });
    assert.equal(adapter.applyPromptPlan({ targetNodeId: 'image-1', prompt: '新画面', negativePrompt: '', parameters: {} }), true);
    assert.equal(node.data.protocolParams.negative_prompt, '');
});

test('unsupported or stale parameter plans leave the entire node unchanged', () => {
    const { adapter, controls, node, getSaves } = harness();
    controls['image-1-aspect'].options = [{ value: '1:1' }, { value: '16:9' }];
    for (const parameters of [
        { aspectRatio: 'unknown' }, { count: -1 }, { count: '2张' },
        { background: 'transparent' }, { modelId: 'another-model' }, { protocolParams: { injected: 'value' } }
    ]) {
        assert.equal(adapter.applyPromptPlan({ targetNodeId: 'image-1', prompt: '不得写入', parameters }), false);
        assert.equal(node.data.prompt, '数据提示词');
        assert.equal(controls['image-1-prompt'].value, '原始提示词');
    }
    assert.equal(getSaves(), 0);
});

test('parameter context exposes current options and omits fields hidden by the selected protocol', () => {
    const { adapter, controls } = harness();
    controls['image-1-resolution'].options = [{ value: '' }, { value: '2K' }];
    controls['image-1-quality'] = { ...control('high'), closest: () => ({ hidden: true }) };
    controls['image-1-custom-resolution-width'] = control('1024');
    const schema = adapter.getSelectedContext().parameterSchema;
    assert.deepEqual(schema.resolution.enum, ['', '2K']);
    assert.equal(schema.quality, undefined);
    assert.equal(schema.customWidth, undefined);
});

test('declared numeric and checkbox protocol controls are validated and applied with their actual types', () => {
    const { adapter, controls, node } = harness();
    const enhance = { ...control(''), id: 'image-1-param-enhance', type: 'checkbox', checked: false };
    const seed = { ...control('0'), id: 'image-1-param-seed', type: 'number', min: '0', max: '100' };
    controls[enhance.id] = enhance;
    controls[seed.id] = seed;
    const hidden = { ...control('internal'), id: 'image-1-param-internal', type: 'hidden' };
    controls['image-1'] = { querySelectorAll: () => [enhance, seed, hidden] };
    assert.deepEqual(adapter.getSelectedContext().parameterSchema.protocolParams, {
        type: 'object', properties: {
            enhance: { type: 'boolean' }, seed: { type: 'number', minimum: 0, maximum: 100 }
        }
    });
    const plan = { targetNodeId: 'image-1', prompt: '画面', parameters: { protocolParams: { enhance: true, seed: 42 } } };
    assert.equal(adapter.applyPromptPlan(plan), true);
    assert.equal(enhance.checked, true);
    assert.equal(seed.value, '42');
    assert.deepEqual(node.data.protocolParams, { enhance: true, seed: 42 });
    assert.equal(adapter.applyPromptPlan({ ...plan, parameters: { protocolParams: { seed: 101 } } }), false);
    assert.equal(seed.value, '42');
});

test('scene references include every imported image, cached originals and active URLs without requiring node selection', () => {
    const original = 'data:image/png;base64,ORIGINAL';
    const thumbnail = 'data:image/webp;base64,THUMB';
    const nodes = [
        { id: 'generated', type: 'ImageGenerate', data: { imageList: [original] } },
        { id: 'multiple', type: 'ImageImport', customTitle: '风景', data: { imageList: [original, thumbnail] } },
        { id: 'cached', type: 'ImageImport', data: { mediaAssetKeys: ['asset:full'], imagePreviewThumbnail: thumbnail } },
        { id: 'legacy', type: 'ImageImport', imageImportAssetKey: 'asset:legacy' },
        { id: 'url', type: 'ImageImport', importMode: 'url', imageUrl: 'https://example.test/old.png', data: { image: original } },
        { id: 'empty', type: 'ImageImport', data: {} },
        { id: 'empty-url', type: 'ImageImport', importMode: 'url', data: { image: original } }
    ];
    const state = { nodes: new Map(nodes.map((node) => [node.id, node])), selectedNodes: new Set() };
    const controls = { 'url-url-input': { value: 'https://example.test/current.png' } };
    const adapter = createPromptAgentNodeAdapter({ state, documentRef: { getElementById: (id) => controls[id] } });
    const references = adapter.getSceneReferenceImages();
    assert.deepEqual(references.map((image) => image.sourceNodeId), ['multiple', 'multiple', 'cached', 'legacy', 'url']);
    assert.deepEqual(references.map((image) => image.name), ['风景 · 1', '风景 · 2', '图片导入 2', '图片导入 3', '图片导入 4']);
    assert.equal(references[2].previewUrl, thumbnail);
    assert.equal(references[4].previewUrl, 'https://example.test/current.png');
    assert.equal(new Set(references.map((image) => image.referenceId)).size, 5);
    assert.equal(adapter.getSelectedContext(), null);
});

test('selecting a cached scene image hydrates its original lazily instead of sending its thumbnail', async () => {
    const node = { id: 'cached', type: 'ImageImport', data: {
        mediaAssetKeys: ['asset:original'], imagePreviewThumbnail: 'data:image/webp;base64,THUMB'
    } };
    const state = { nodes: new Map([[node.id, node]]) };
    let reads = 0;
    let saves = 0;
    const adapter = createPromptAgentNodeAdapter({
        state, documentRef: { getElementById: () => null }, scheduleSave: () => { saves += 1; },
        getNodeImages: async (source) => {
            assert.equal(source, node);
            reads += 1;
            return ['data:image/png;base64,ORIGINAL'];
        }
    });
    const [reference] = adapter.getSceneReferenceImages();
    assert.equal(reads, 0);
    const result = await adapter.readSceneReferenceImage(reference);
    assert.equal(result.dataUrl, 'data:image/png;base64,ORIGINAL');
    assert.equal(result.type, 'image/png');
    assert.equal(result.referenceId, reference.referenceId);
    assert.equal(reads, 1);
    assert.equal(saves, 0);
});

test('URL imports resolve to sendable image data and reject unreadable sources', async () => {
    const node = { id: 'url', type: 'ImageImport', importMode: 'url', imageUrl: 'https://example.test/image.png' };
    const state = { nodes: new Map([[node.id, node]]) };
    let source;
    let resolved = 'data:image/png;base64,FULL';
    const adapter = createPromptAgentNodeAdapter({
        state, documentRef: { getElementById: () => null },
        getNodeImages: () => { throw new Error('URL imports must use the current URL'); },
        resolveImageSource: async (value) => { source = value; return resolved; }
    });
    const [reference] = adapter.getSceneReferenceImages();
    assert.equal((await adapter.readSceneReferenceImage(reference)).dataUrl, resolved);
    assert.equal(source, node.imageUrl);
    resolved = 'data:text/html;base64,NOT_AN_IMAGE';
    await assert.rejects(adapter.readSceneReferenceImage(reference), /检查图片来源/);
});

test('scene-image reads reject sources replaced or removed during asynchronous resolution', async () => {
    for (const change of ['workflow', 'asset', 'deleted']) {
        const node = { id: 'import', type: 'ImageImport', data: { mediaAssetKeys: ['asset:old'] } };
        const state = { nodes: new Map([[node.id, node]]) };
        let finish;
        const adapter = createPromptAgentNodeAdapter({
            state, documentRef: { getElementById: () => null },
            getNodeImages: () => new Promise((resolve) => { finish = () => resolve(['data:image/png;base64,OLD']); })
        });
        const reading = adapter.readSceneReferenceImage(adapter.getSceneReferenceImages()[0]);
        if (change === 'workflow') state.nodes.set(node.id, { ...node });
        if (change === 'asset') node.data.mediaAssetKeys = ['asset:new'];
        if (change === 'deleted') state.nodes.delete(node.id);
        finish();
        await assert.rejects(reading, /已变化/);
    }
});
