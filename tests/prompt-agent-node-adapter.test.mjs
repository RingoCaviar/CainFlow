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
    const node = { id: 'image-1', type: nodeType, data: { prompt: '数据提示词' } };
    const state = {
        selectedNodes: new Set(selected),
        nodes: new Map([['image-1', node]]),
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
        parameters: { aspectRatio: '1:1', resolution: '1024x1024', count: 1 },
        referenceImages: [{ sourceNodeId: 'source-1', sourcePort: 'image', targetPort: 'image_1' }]
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
    assert.equal(controls['image-1-generation-count'].value, '2');
    assert.equal(node.data.prompt, '电影感城市夜景');
    assert.equal(node.data.promptAgentNegativePrompt, '卡通、过度饱和');
    assert.equal(getSaves(), 1);
});
