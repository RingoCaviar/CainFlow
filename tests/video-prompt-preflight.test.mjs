import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowRunnerApi, getNodePromptPortIds, getNodePromptValue } from '../js/features/execution/workflow-runner.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createReferenceImageCatalog } from '../js/features/media/reference-image-catalog.js';
import { registerPromptImageMention } from '../js/nodes/prompt-image-mentions.js';
import { renderProtocolParameter } from '../js/nodes/protocol-ui-renderer.js';
import { createNodeElement } from './helpers/node-element-fixture.mjs';
import '../js/features/execution/protocols/veo-unified.js';

test('video preflight accepts the prompt field rendered from its selected protocol', () => {
    const documentRef = {
        getElementById(id) {
            return id === 'video-1-param-prompt' ? { value: '猫吃草' } : null;
        }
    };

    assert.equal(
        getNodePromptValue({ id: 'video-1', type: 'VideoGenerate', data: {} }, documentRef),
        '猫吃草'
    );
});

test('video preflight accepts a required protocol text parameter with a nonstandard ID', () => {
    const documentRef = {
        getElementById: () => null,
        querySelector: (selector) => selector === '#video-custom [data-protocol-prompt="true"]'
            ? { value: '镜头缓慢推进' }
            : null
    };

    assert.equal(
        getNodePromptValue({ id: 'video-custom', type: 'VideoGenerate', data: {} }, documentRef),
        '镜头缓慢推进'
    );
});

test('a required protocol text parameter is rendered as the protocol prompt', () => {
    const markup = renderProtocolParameter('video-custom', {
        id: 'sceneDescription', required: true, inputPort: true, portType: 'text', uiControl: 'textarea'
    });

    assert.match(markup, /data-protocol-prompt="true"/);
});

test('a required textarea parameter remains the protocol prompt without port type metadata', () => {
    const markup = renderProtocolParameter('video-custom', {
        id: 'sceneDescription', required: true, inputPort: true, uiControl: 'textarea'
    });

    assert.match(markup, /data-protocol-prompt="true"/);
});

test('video preflight recognizes a declared nonstandard protocol prompt port', () => {
    const documentRef = {
        querySelectorAll: (selector) => selector === '#video-custom [data-protocol-prompt="true"]'
            ? [{ id: 'video-custom-param-sceneDescription' }]
            : []
    };

    assert.deepEqual(
        getNodePromptPortIds({ id: 'video-custom', type: 'VideoGenerate' }, documentRef),
        ['prompt', 'sceneDescription']
    );
});

test('text chat preflight retains its legacy prompt field', () => {
    const documentRef = {
        getElementById(id) {
            return id === 'chat-1-prompt' ? { value: '请总结这段文字' } : null;
        }
    };

    assert.equal(
        getNodePromptValue({ id: 'chat-1', type: 'TextChat', data: {} }, documentRef),
        '请总结这段文字'
    );
});

test('mentioning the first frame of a multi-image input rejects a different frame batch before any video request', async () => {
    const images = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'];
    const source = { id: 'source', type: 'ImagePreview', enabled: true, data: { imageList: images }, el: createNodeElement() };
    const node = { id: 'video', type: 'VideoGenerate', enabled: true, data: {}, el: createNodeElement() };
    source.el.classList.contains = node.el.classList.contains = () => false;
    const state = {
        nodes: new Map([[source.id, source], [node.id, node]]), selectedNodes: new Set([node.id]),
        connections: [{ id: 'frame-edge', type: 'image', from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'image_1' } }],
        models: [{ id: 'veo', modelId: 'veo-3', taskType: 'video', protocol: 'veo-unified', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://fixture.example', apikey: 'fixture-key' }],
        canvas: { x: 0, y: 0, zoom: 1 }, requestTimeoutEnabled: false
    };
    const catalog = createReferenceImageCatalog({ state });
    const token = registerPromptImageMention(node, catalog.getUpstream(node.id)[0], '@', { start: 0, end: 1 });
    const fields = { 'video-apiconfig': 'veo', 'video-provider': 'provider', 'video-param-prompt': `沿用 ${token}` };
    const documentRef = { getElementById: id => fields[id] ? { value: fields[id] } : null,
        querySelectorAll: () => [], defaultView: { requestAnimationFrame: callback => callback() } };
    const noop = () => {};
    const core = createExecutionCoreApi({ state, nodeConfigs: {}, referenceImageCatalog: catalog,
        documentRef, windowRef: documentRef.defaultView, showToast: noop, addLog: noop });
    const executions = [];
    const runner = createWorkflowRunnerApi({ state, nodeConfigs: {}, documentRef, confirmRef: () => true,
        normalizeRunOptions: core.normalizeRunOptions, resolveExecutionPlan: core.resolveExecutionPlan, getCachedOutputValue: core.getCachedOutputValue,
        executeNode: (...args) => { executions.push(args); },
        showToast: noop, addLog: noop, scheduleSave: noop, updatePortStyles: noop, getAbortMessage: () => '' });
    await runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [node.id] });
    assert.deepEqual(executions, []);
    assert.match(node.executionFailure?.message || '', /当前视频批次的帧输入不包含 @图片1/);
    assert.equal(node.executionFailure?.inputPort, 'image_1');
});
