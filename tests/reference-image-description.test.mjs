import assert from 'node:assert/strict';
import test from 'node:test';
import { appendReferenceDescriptions, getImageDescription, setImageDescription } from '../js/features/execution/reference-image-description.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { resolveVideoExecutionInputRecord } from '../js/nodes/video-execution-input-record.js';

test('connected image descriptions follow request image order without changing the saved prompt', () => {
    const first = { data: {} };
    const second = { data: {} };
    setImageDescription(first, '  保留主体五官  ');
    setImageDescription(second, '使用暖色背景');
    const state = {
        nodes: new Map([['first', first], ['second', second]]),
        connections: [
            { from: { nodeId: 'second' }, to: { nodeId: 'target', port: 'image_2' } },
            { from: { nodeId: 'first' }, to: { nodeId: 'target', port: 'image_1' } }
        ]
    };
    assert.equal(getImageDescription(first), '保留主体五官');
    assert.equal(appendReferenceDescriptions('画一张肖像', state, 'target'),
        '画一张肖像\n\n参考图 1：保留主体五官\n参考图 2：使用暖色背景');
    assert.equal(appendReferenceDescriptions('其他节点', state, 'other'), '其他节点');
    assert.equal(first.data.imageDescription, '保留主体五官');
});

test('Agent sends each image description in its catalog and retains it after workflow restoration', () => {
    const image = { name: '主体', description: '保留蓝色外套', dataUrl: 'data:image/png;base64,AAAA' };
    const input = createPromptAgentInput({ message: '请继续', referenceImages: [image], model: { protocol: 'openai' } });
    const catalog = JSON.parse(input.messages.at(-1).content).images;
    assert.equal(catalog[0].description, image.description);
    assert.equal(input.media.length, 1);

    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '请继续', referenceImages: [image] });
    const restored = createPromptAgentConversationStore();
    restored.restore(store.snapshot());
    assert.equal(restored.getReferenceImages()[0].description, image.description);
});

test('workflow serialization saves image descriptions beside image import nodes', () => {
    const node = { id: 'source', type: 'ImageImport', x: 0, y: 0, enabled: true,
        data: { imageDescription: '  保留人物脸部  ' } };
    const state = { nodes: new Map([[node.id, node]]), connections: [], canvas: { x: 0, y: 0 } };
    const documentRef = { getElementById: () => null, querySelectorAll: () => [] };
    const [saved] = createNodeSerializer({ state, documentRef }).serializeNodes();
    assert.equal(saved.imageDescription, '保留人物脸部');
});

test('batch source descriptions follow each image in request order', () => {
    const source = { data: { imageList: ['first', 'second'] } };
    setImageDescription(source, '正面', 0);
    setImageDescription(source, '侧面', 1);
    setImageDescription(source, '正面新描述', 0);
    const state = { nodes: new Map([['source', source]]), connections: [
        { from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' } }
    ] };
    assert.equal(appendReferenceDescriptions('生成肖像', state, 'target'), '生成肖像\n\n参考图 1：正面新描述\n参考图 2：侧面');
    const [saved] = createNodeSerializer({ state: { ...state, nodes: new Map([['source', { ...source, id: 'source', type: 'ImageImport', x: 0, y: 0 }]]) },
        documentRef: { getElementById: () => null, querySelectorAll: () => [] } }).serializeNodes();
    assert.deepEqual(saved.imageDescriptions, ['正面新描述', '侧面']);
});

test('video execution record includes reference descriptions with a connected prompt', () => {
    const record = resolveVideoExecutionInputRecord({
        inputs: { prompt: '运动中的人物' },
        prompt: '节点中的提示词',
        promptSuffix: '参考图 1：保留蓝色外套'
    });
    assert.equal(record.prompt, '运动中的人物\n\n参考图 1：保留蓝色外套');
    assert.equal(record.inputs.prompt, record.prompt);
    assert.equal(Object.isFrozen(record), true);
});

test('editing a sent Agent reference updates the persisted conversation', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '参考', referenceImages: [{ name: '图', dataUrl: 'data:image/png;base64,AAAA' }] });
    assert.equal(store.updateReferenceDescription(0, 0, '保留构图'), true);
    assert.equal(store.snapshot().messages[0].referenceImages[0].description, '保留构图');
    assert.equal(store.getReferenceImages()[0].description, '保留构图');
});
