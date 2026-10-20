import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';

test('applies a Prompt Plan and runs only its selected image node through the existing workflow seam', async () => {
    const calls = [];
    const node = { id: 'image-1', type: 'ImageGenerate', data: { images: ['data:image/png;base64,b2s='] } };
    const adapter = createPromptAgentExecutionAdapter({
        state: { nodes: new Map([[node.id, node]]) },
        nodeAdapter: { applyPromptPlan: (plan) => { calls.push(['apply', plan]); return true; } },
        runWorkflow: async (input) => { calls.push(['run', input]); return { started: true, executed: true, reason: 'finished' }; },
        cancelRunningNode: (nodeId) => { calls.push(['cancel', nodeId]); return true; },
        focusNode: (nodeId) => { calls.push(['focus', nodeId]); return true; }
    });
    const plan = { targetNodeId: 'image-1', prompt: '城市夜景', parameters: {} };

    const result = await adapter.applyAndGenerate(plan);

    assert.deepEqual(calls.slice(0, 2), [
        ['apply', plan],
        ['run', { mode: 'selected-only', selectedNodeIds: ['image-1'] }]
    ]);
    assert.deepEqual(result, { status: 'completed', images: ['data:image/png;base64,b2s='] });
    assert.equal(adapter.stop('image-1'), true);
    assert.equal(adapter.focus('image-1'), true);
});

test('reports rejected application and failed workflow results without switching execution providers', async () => {
    const rejected = createPromptAgentExecutionAdapter({
        state: { nodes: new Map() },
        nodeAdapter: { applyPromptPlan: () => false },
        runWorkflow: async () => { throw new Error('must not run'); }
    });
    await assert.rejects(() => rejected.applyAndGenerate({ targetNodeId: 'missing' }), /不再是当前选中的生图节点/);

    const failed = createPromptAgentExecutionAdapter({
        state: { nodes: new Map([['image-1', { id: 'image-1', type: 'ImageGenerate', data: {} }]]) },
        nodeAdapter: { applyPromptPlan: () => true },
        runWorkflow: async () => ({ started: true, executed: false, reason: 'error' })
    });
    await assert.rejects(() => failed.applyAndGenerate({ targetNodeId: 'image-1' }), /检查节点配置/);
});

test('maps existing workflow timeout and external cancellation outcomes without showing stale success', async () => {
    const state = { nodes: new Map([['image-1', { id: 'image-1', type: 'ImageGenerate', data: { images: ['old-image'] } }]]) };
    const create = (outcome) => createPromptAgentExecutionAdapter({
        state,
        nodeAdapter: { applyPromptPlan: () => true },
        runWorkflow: async () => ({ started: true, executed: true, reason: 'finished', outcome })
    });

    await assert.rejects(() => create('timeout').applyAndGenerate({ targetNodeId: 'image-1' }), /生成超时/);
    assert.deepEqual(
        await create('cancelled').applyAndGenerate({ targetNodeId: 'image-1' }),
        { status: 'stopped', images: [] }
    );
});
