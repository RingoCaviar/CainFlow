import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';

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
    return { adapter, controls, node, getSaves: () => saves };
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

test('applies a Prompt Plan only while its image-generation node remains selected', () => {
    const { adapter, controls, node, getSaves } = harness();
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
