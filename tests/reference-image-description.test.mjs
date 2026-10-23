import assert from 'node:assert/strict';
import test from 'node:test';
import { appendReferenceDescriptions, getImageDescription, setImageDescription } from '../js/features/execution/reference-image-description.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';

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
