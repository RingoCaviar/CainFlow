import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createImageGenerationRevisionApi } from '../js/nodes/image-generation-revision.js';
import { registerProtocol, setProtocolOverride, clearProtocolOverride, getProtocol, deleteProtocol } from '../js/features/execution/protocols/index.js';
import { GoogleProtocol } from '../js/features/execution/protocols/google.js';
import { TtapiOpenaiProtocol } from '../js/features/execution/protocols/ttapi-openai.js';

function fixture(protocol = 'google') {
    registerProtocol(protocol === 'google' ? GoogleProtocol : TtapiOpenaiProtocol);
    clearProtocolOverride(protocol);
    const node = { id: 'target', type: 'ImageGenerate', apiConfigId: 'image', providerId: 'provider', data: { prompt: 'effective recipe', generationCount: 1, resolution: 'auto' } };
    const state = { nodes: new Map([[node.id, node]]), connections: [],
        models: [{ id: 'image', modelId: protocol === 'google' ? 'gemini-3.1-flash-image-preview' : 'gpt-image-1', protocol, taskType: 'image', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'provider', endpoint: 'https://controlled.test', apikey: 'fixture' }] };
    const documentRef = { getElementById: () => null, querySelectorAll: () => [] };
    const core = createExecutionCoreApi({ state, nodeConfigs: {}, documentRef, windowRef: {} });
    const revision = createImageGenerationRevisionApi({ state, documentRef, getCachedOutputValue: core.getCachedOutputValue });
    return { node, state, core, revision, model: state.models[0], provider: state.providers[0], preview: () => core.buildNodeRequestPreview(node.id).requestBody };
}

test('same-model effective thinking defaults alter the public request and mark the confirmed generation pending', () => {
    const f = fixture(); f.model.thinking = { profile: 'google-image', default: { mode: 'level', value: 'minimal' } };
    f.revision.initializeNode(f.node.id);
    assert.equal(f.preview().generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    f.model.thinking.default.value = 'high';
    assert.equal(f.preview().generationConfig.thinkingConfig.thinkingLevel, 'high');
    f.revision.observeAll(); assert.equal(f.node.generationDirty, true);
});

test('only effective thinking changes matter, including a provider capability that invalidates an inherited default', () => {
    const f = fixture(); f.model.thinking = { profile: 'google-image', default: { mode: 'level', value: 'minimal' } };
    f.node.data.thinking = { mode: 'level', value: 'minimal' }; f.revision.initializeNode(f.node.id);
    const original = f.preview();
    f.model.name = 'renamed'; f.provider.name = 'renamed'; f.provider.apikey = 'rotated'; f.model.thinking.default.value = 'high';
    assert.deepEqual(f.preview(), original); f.revision.observeAll(); assert.equal(f.node.generationDirty, false);
    f.model.thinking.providers = { provider: 'none' };
    assert.throws(f.preview, /不可用/);
    assert.doesNotThrow(() => f.revision.observeAll()); assert.equal(f.node.generationDirty, true);
});

test('same-ID protocol overrides change the public reference wire field while presentation-only overrides stay clean', t => {
    const f = fixture('ttapi-openai'); t.after(() => clearProtocolOverride('ttapi-openai'));
    const source = { id: 'source', type: 'ImagePreview', data: { mediaAssetKeys: ['media:original'], imageCount: 1, imageList: ['data:image/png;base64,AAAA'] } };
    f.state.nodes.set(source.id, source); f.state.connections.push({ id: 'reference', type: 'image', order: 0, from: { nodeId: source.id, port: 'image' }, to: { nodeId: f.node.id, port: 'referenceImages' } });
    f.revision.initializeNode(f.node.id);
    const original = f.preview(); assert.ok(original.images); assert.equal(original.reference_images, undefined);
    setProtocolOverride('ttapi-openai', { protocolId: 'ttapi-openai', config: { label: 'renamed protocol', name: 'presentation name',
        parameters: { referenceImages: { label: 'renamed socket', portLabel: 'renamed {index}', note: 'new help' },
            size: { options: getProtocol('ttapi-openai').parameters.size.options.map(option => ({ ...option, label: `renamed ${option.label}` })) } } } });
    assert.deepEqual(f.preview(), original); f.revision.observeAll(); assert.equal(f.node.generationDirty, false);
    setProtocolOverride('ttapi-openai', { protocolId: 'ttapi-openai', config: { parameters: { referenceImages: { requestField: 'reference_images' } } } });
    const changed = f.preview(); assert.deepEqual(changed.reference_images, original.images); assert.equal(changed.images, undefined);
    f.revision.observeAll(); assert.equal(f.node.generationDirty, true);
});

test('protocol projection keeps a literal nested request-body label and ignores inactive variant configuration', t => {
    const f = fixture('ttapi-openai'); t.after(() => clearProtocolOverride('ttapi-openai'));
    const override = label => ({ protocolId: 'ttapi-openai', config: { fixedParams: { payload: { label } },
        variants: { 'gpt-image-1': { parameters: { prompt: { requestField: 'prompt' } } }, 'another-model': { fixedParams: { unused: 'first' } } } } });
    setProtocolOverride('ttapi-openai', override('wire-one')); f.revision.initializeNode(f.node.id);
    const build = () => getProtocol('ttapi-openai').buildRequest({ parameters: { prompt: 'effective recipe' }, inputs: {}, modelConfig: f.model, taskType: 'image' });
    assert.equal(build().payload.label, 'wire-one');
    const inactive = override('wire-one'); inactive.config.variants['another-model'].fixedParams.unused = 'changed';
    setProtocolOverride('ttapi-openai', inactive); f.revision.observeAll(); assert.equal(f.node.generationDirty, false);
    setProtocolOverride('ttapi-openai', override('wire-two')); assert.equal(build().payload.label, 'wire-two');
    f.revision.observeAll(); assert.equal(f.node.generationDirty, true);
});

test('restoring a confirmed recipe while its protocol module is still loading preserves clean initialization', t => {
    const f = fixture(); t.after(() => registerProtocol(GoogleProtocol));
    f.revision.initializeNode(f.node.id); assert.equal(f.revision.completeAttempt(f.revision.beginAttempt(f.node, {}), { succeeded: true }), true);
    deleteProtocol('google');
    const reopened = createImageGenerationRevisionApi({ state: f.state, documentRef: { getElementById: () => null, querySelectorAll: () => [] } });
    reopened.initializeNode(f.node.id); reopened.observeAll({ initialize: true });
    registerProtocol(GoogleProtocol); reopened.observeAll({ initialize: true });
    assert.equal(f.node.generationDirty, false); assert.equal(f.node.data.generationRevision.dirty, false);
});
