import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getImageAspectOptionsForProtocol,
    getImageAspectSelectState,
    getImageResolutionOptionsForProtocol,
    normalizeImageSizeControls,
    resolveImageRequestSize,
    validateOpenAiImageSize
} from '../js/features/execution/image-generation-size.js';
import { getGoogleImageCapabilities } from '../js/features/execution/google-image-capabilities.js';
import { createNodeMarkup } from '../js/nodes/node-view-factory.js';
import { imageGenerateNode } from '../js/nodes/types/image-generate.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { buildGoogleImageRequest, buildNewApiAsyncImageRequest, buildTtapiImageRequest, validateOpenAiImageResolutionOptions } from '../js/features/execution/provider-request-utils.js';

test('OpenAI resolution tiers and ratios produce valid exact request sizes', () => {
    assert.equal(validateOpenAiImageResolutionOptions(), true);
    const aspectOptions = getImageAspectOptionsForProtocol('openai').map(({ value }) => value).filter(Boolean);
    for (const resolution of ['1K', '2K', '4K']) {
        for (const aspect of aspectOptions) {
            const request = resolveImageRequestSize({ protocol: 'openai', resolution, aspect });
            const [width, height] = request.resolution.split('x').map(Number);
            assert.equal(validateOpenAiImageSize(width, height).valid, true, `${resolution} ${aspect}`);
            assert.equal(request.aspect, '');
            assert.equal(request.display, `${width} × ${height} px`);
            const [ratioWidth, ratioHeight] = aspect.split(':').map(Number);
            assert.ok(Math.abs(width / height - ratioWidth / ratioHeight) < 0.015, `${resolution} ${aspect}`);
        }
    }
});

test('OpenAI compatible image ratios do not offer a misleading automatic choice', () => {
    for (const protocol of ['openai', 'ttapi-openai']) {
        const options = getImageAspectOptionsForProtocol(protocol);
        assert.equal(options.some(({ value, label }) => value === '' || label === '自动'), false, protocol);
        assert.equal(options[0].value, '1:1');
    }
});

test('legacy pixel dimensions migrate to separate controls; custom size remains editable and validated', () => {
    assert.deepEqual(normalizeImageSizeControls({ resolution: '2048x1152' }, 'openai'), {
        resolution: '2K', aspect: '16:9', customWidth: '', customHeight: ''
    });
    assert.deepEqual(normalizeImageSizeControls({ resolution: '1536x864' }, 'openai'), {
        resolution: '1K', aspect: '16:9', customWidth: '', customHeight: ''
    });
    assert.deepEqual(normalizeImageSizeControls({ resolution: '1920x1088' }, 'openai'), {
        resolution: 'custom', aspect: '', customWidth: '1920', customHeight: '1088'
    });
    assert.deepEqual(resolveImageRequestSize({ protocol: 'openai', resolution: 'custom', customWidth: '1920', customHeight: '1088' }), {
        resolution: '1920x1088', aspect: '', display: '1920 × 1088 px'
    });
    assert.throws(() => resolveImageRequestSize({ protocol: 'openai', resolution: 'custom', customWidth: '1921', customHeight: '1088' }), /16px/);
    assert.equal(getImageResolutionOptionsForProtocol('google').some(({ value }) => value === 'custom'), false);
    assert.equal(resolveImageRequestSize({ protocol: 'google', resolution: '2K', aspect: '16:9' }).resolution, '2K');
    assert.equal(resolveImageRequestSize({ protocol: 'newapi-image-async', resolution: '2K', aspect: '16:9' }).resolution, '2k');
});

test('OpenAI migrates an empty saved ratio to an explicit square ratio', () => {
    assert.deepEqual(normalizeImageSizeControls({ resolution: '2K', aspect: '' }, 'openai'), {
        resolution: '2K', aspect: '1:1', customWidth: '', customHeight: ''
    });
    assert.deepEqual(resolveImageRequestSize({ protocol: 'openai', resolution: '2K', aspect: '' }), {
        resolution: '2048x2048', aspect: '', display: '2048 × 2048 px'
    });
});

test('fixed-size models offer only their documented dimensions and reject incompatible sizes', () => {
    const protocol = 'openai';
    const mini = 'gpt-image-1-mini';
    assert.deepEqual(getImageResolutionOptionsForProtocol(protocol, mini).map(({ value }) => value), ['', '1K']);
    assert.deepEqual(getImageAspectOptionsForProtocol(protocol, mini).map(({ value }) => value), ['1:1', '2:3', '3:2']);
    assert.equal(resolveImageRequestSize({ protocol, modelId: mini, resolution: '1K', aspect: '2:3' }).resolution, '1024x1536');
    assert.throws(() => resolveImageRequestSize({ protocol, modelId: mini, resolution: '2K', aspect: '16:9' }), /不支持/);
    assert.throws(() => resolveImageRequestSize({ protocol, modelId: mini, resolution: '1K', aspect: '16:9' }), /不支持/);
    assert.equal(resolveImageRequestSize({ protocol, modelId: 'dall-e-2', resolution: '512x512' }).resolution, '512x512');
    assert.equal(resolveImageRequestSize({ protocol, modelId: 'dall-e-3', resolution: '1K', aspect: '7:4' }).resolution, '1792x1024');
    assert.equal(resolveImageRequestSize({ protocol, modelId: 'gpt-image-2.5-sunburst-2026-09-08', resolution: '2K', aspect: '16:9' }).resolution, '2048x1152');
});

test('image node offers model-specific quality values and hides unsupported controls', () => {
    function render(modelId, quality) {
        return createNodeMarkup({
            type: 'ImageGenerate', id: 'image', config: imageGenerateNode,
            restoreData: { apiConfigId: 'model', quality },
            state: { models: [{ id: 'model', modelId, protocol: 'openai', taskType: 'image' }], providers: [] }
        });
    }
    const legacy = render('dall-e-3', 'hd');
    assert.match(legacy, /id="image-quality">[^<]*<option[^]*?<option value="hd" selected>/);
    assert.match(legacy, /class="[^\"]*\bhidden" id="image-moderation-field"/);
    assert.match(legacy, /class="[^\"]*\bhidden" id="image-background-field"/);
    assert.doesNotMatch(legacy, /<option value="2K"/);
    const modern = render('gpt-image-2.5-flare', 'xhigh');
    assert.match(modern, /<option value="xhigh" selected>/);
    assert.match(modern, /<option value="max">/);
});

test('non-OpenAI requests keep resolution tier and aspect ratio as independent fields', () => {
    const googleSize = resolveImageRequestSize({ protocol: 'google', resolution: '4K', aspect: '3:2' });
    assert.deepEqual(buildGoogleImageRequest({ prompt: '山谷', ...googleSize }).generationConfig.imageConfig, {
        aspectRatio: '3:2', imageSize: '4K'
    });
    const newApiSize = resolveImageRequestSize({ protocol: 'newapi-image-async', resolution: '2K', aspect: '16:9' });
    assert.deepEqual(buildNewApiAsyncImageRequest({ modelCfg: { modelId: 'image-model' }, prompt: '山谷', ...newApiSize }), {
        model: 'image-model', prompt: '山谷', aspect_ratio: '16:9', resolution: '2k'
    });
    const ttapiSize = resolveImageRequestSize({ protocol: 'ttapi', resolution: '', aspect: '1:1' });
    assert.equal(ttapiSize.display, '1K（具体像素由模型决定）');
    assert.equal(buildTtapiImageRequest({ modelCfg: { modelId: 'image-model' }, prompt: '山谷', ...ttapiSize }).image_size, '1K');
});

test('known Gemini image models expose their documented reference and search capabilities', () => {
    for (const [modelId, references, web, images] of [
        ['gemini-nano-banana-2.1', 14, true, true],
        ['gemini-3.1-flash-image', 14, true, true],
        ['gemini-3.1-flash-image-preview', 14, true, true],
        ['gemini-3.1-flash-lite-image', 14, false, false],
        ['gemini-3-pro-image', 14, true, false],
        ['gemini-3-pro-image-preview', 14, true, false],
        ['gemini-2.5-flash-image', 3, false, false],
        ['gemini-2.5-flash-image-preview', 3, false, false],
        ['imagen-4.0-generate-001', 0, false, false]
    ]) {
        const capabilities = getGoogleImageCapabilities(modelId);
        assert.equal(capabilities.maxReferences, references, modelId);
        assert.equal(capabilities.search, web, modelId);
        assert.equal(capabilities.imageSearch, images, modelId);
    }
    assert.equal(getGoogleImageCapabilities('relay-gemini-3-pro-image'), undefined);
});

test('Gemini size choices and request values depend on the selected image model', () => {
    const protocol = 'google';
    const flash = 'gemini-3.1-flash-image';
    const lite = 'gemini-3.1-flash-lite-image';
    const pro = 'gemini-3-pro-image';
    const legacy = 'gemini-2.5-flash-image';
    const banana = 'gemini-nano-banana-2.1';
    const values = options => options.map(option => option.value);
    assert.deepEqual(values(getImageResolutionOptionsForProtocol(protocol, flash)), ['', '512', '1K', '2K', '4K']);
    assert.deepEqual(values(getImageResolutionOptionsForProtocol(protocol, banana)), ['', '1K', '2K', '4K']);
    assert.deepEqual(values(getImageResolutionOptionsForProtocol(protocol, lite)), ['']);
    assert.deepEqual(values(getImageResolutionOptionsForProtocol(protocol, legacy)), ['']);
    assert.deepEqual(values(getImageAspectOptionsForProtocol(protocol, flash)), values(getImageAspectOptionsForProtocol(protocol, lite)));
    assert.equal(getImageAspectOptionsForProtocol(protocol, flash).length, 15);
    assert.equal(getImageAspectOptionsForProtocol(protocol, pro).length, 11);
    assert.equal(getImageAspectSelectState(protocol, '2K', '8:1', pro).value, '');
    assert.equal(resolveImageRequestSize({ protocol, modelId: flash, resolution: '512', aspect: '8:1' }).resolution, '512');
    assert.equal(resolveImageRequestSize({ protocol, modelId: legacy, resolution: '1k', aspect: '21:9' }).resolution, '');
    assert.equal(resolveImageRequestSize({ protocol, modelId: lite, aspect: '1:8' }).aspect, '1:8');
    assert.throws(() => resolveImageRequestSize({ protocol, modelId: lite, resolution: '4K' }), /不支持/);
    assert.throws(() => resolveImageRequestSize({ protocol, modelId: banana, resolution: '512' }), /不支持/);
    assert.throws(() => resolveImageRequestSize({ protocol, modelId: pro, aspect: '1:8' }), /不支持/);
    assert.equal(resolveImageRequestSize({ protocol, modelId: 'custom-image', resolution: '4K', aspect: '8:1' }).aspect, '8:1');
});

test('image node renders separate controls and a read-only request resolution', () => {
    const state = {
        models: [{ id: 'model', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', type: 'openai', endpoint: 'https://api.openai.com/v1' }]
    };
    const markup = createNodeMarkup({
        type: 'ImageGenerate', id: 'image', config: imageGenerateNode,
        restoreData: { apiConfigId: 'model', providerId: 'provider', resolution: '2048x1152' }, state
    });
    assert.match(markup, /id="image-aspect"[^>]*>[\s\S]*?<option value="16:9" selected>/);
    assert.match(markup, /id="image-resolution"[^>]*>[\s\S]*?<option value="2K" selected>/);
    assert.match(markup, /<output[^>]*id="image-requested-resolution"[^>]*>2048 × 1152 px<\/output>/);
    assert.match(markup, /id="image-custom-resolution-field"/);
    assert.match(markup, /image-custom-resolution hidden/);

    const emptyAspectMarkup = createNodeMarkup({
        type: 'ImageGenerate', id: 'image-empty', config: imageGenerateNode,
        restoreData: { apiConfigId: 'model', providerId: 'provider', resolution: '2K', aspect: '' }, state
    });
    assert.match(emptyAspectMarkup, /id="image-empty-aspect"[^>]*>[\s\S]*?<option value="1:1" selected>/);
    assert.doesNotMatch(emptyAspectMarkup, /id="image-empty-aspect"[^>]*>\s*<option value=""[^>]*>自动<\/option>/);
    assert.match(emptyAspectMarkup, /id="image-empty-resolution"[^>]*>[\s\S]*?<option value="2K" selected>/);
    assert.match(emptyAspectMarkup, /<output[^>]*id="image-empty-requested-resolution"[^>]*>2048 × 2048 px<\/output>/);
});

test('OpenAI request preview and execution use the same combined resolution and ratio', async () => {
    const node = { id: 'image', type: 'ImageGenerate', data: {}, enabled: true };
    const elements = new Map(Object.entries({
        'image-apiconfig': { value: 'model' },
        'image-provider': { value: 'provider' },
        'image-aspect': { value: '16:9' },
        'image-resolution': { value: '2K' },
        'image-quality': { value: 'auto' },
        'image-moderation': { value: 'auto' },
        'image-background': { value: 'auto' },
        'image-search': { checked: false },
        'image-generation-count': { value: '1' },
        'image-prompt': { value: '山谷' }
    }));
    let sentBody;
    const api = createExecutionCoreApi({
        state: {
            nodes: new Map([[node.id, node]]), connections: [],
            models: [{ id: 'model', name: 'GPT Image 2', modelId: 'gpt-image-2', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', apikey: '<REDACTED>', type: 'openai' }]
        },
        nodeConfigs: {},
        documentRef: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        fetchRef: async (_url, options) => { sentBody = JSON.parse(options.body); throw new Error('request captured'); },
        showToast: () => {}, addLog: () => {}, getProxyHeaders: () => ({}),
        classifyProviderError: () => ({ message: 'request captured' }), logRequestToPanel: () => {},
        fitNodeToContent: () => {}, refreshDependentImageResizePreviews: async () => {}, getAbortMessage: () => ''
    });

    const preview = api.buildNodeRequestPreview(node.id);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal), /request captured/);
    assert.equal(preview.requestBody.size, '2048x1152');
    assert.deepEqual(sentBody, preview.requestBody);
    assert.equal('aspect_ratio' in sentBody, false);

    elements.get('image-aspect').value = '';
    const legacyEmptyAspectPreview = api.buildNodeRequestPreview(node.id);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal), /request captured/);
    assert.equal(legacyEmptyAspectPreview.requestBody.size, '2048x2048');
    assert.deepEqual(sentBody, legacyEmptyAspectPreview.requestBody);
});


test('unmounted generation controls use the same saved request for preview and execution', async () => {
    const node = { id: 'unmounted-image', type: 'ImageGenerate', apiConfigId: 'model', providerId: 'provider', enabled: true,
        data: { prompt: 'winter station', resolution: 'custom', customWidth: '1536', customHeight: '1024', quality: 'high',
            moderation: 'low', background: 'transparent', search: true, generationCount: 2 } };
    let sentBody;
    const api = createExecutionCoreApi({ state: { nodes: new Map([[node.id,node]]), connections: [],
        models: [{ id: 'model', modelId: 'gpt-image-2', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test', type: 'openai' }] }, nodeConfigs: {},
        documentRef: { getElementById: () => null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: callback => callback() },
        fetchRef: async (_url,options) => { sentBody=JSON.parse(options.body); throw new Error('captured saved request'); },
        showToast() {}, addLog() {}, getProxyHeaders: () => ({}), classifyProviderError: () => ({ message: 'captured saved request' }),
        logRequestToPanel() {}, fitNodeToContent() {}, refreshDependentImageResizePreviews: async () => {}, getAbortMessage: () => '' });
    const preview=api.buildNodeRequestPreview(node.id);
    assert.deepEqual({prompt:preview.requestBody.prompt,size:preview.requestBody.size,quality:preview.requestBody.quality,
        moderation:preview.requestBody.moderation,background:preview.requestBody.background},
        {prompt:'winter station',size:'1536x1024',quality:'high',moderation:'low',background:'transparent'});
    await assert.rejects(api.nodeHandlers.ImageGenerate(node,{},new AbortController().signal),/captured saved request/);
    assert.deepEqual(sentBody,preview.requestBody);
});
