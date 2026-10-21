import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';

test('an unavailable plan reference prevents any generation request', async () => {
    const node = { id: 'target', type: 'ImageGenerate', data: {} };
    const state = { nodes: new Map([[node.id, node]]), connections: [] };
    const nodeAdapter = createPromptAgentNodeAdapter({ state, documentRef: { getElementById: () => null } });
    let requested = false;
    const adapter = createPromptAgentExecutionAdapter({ state, nodeAdapter, runWorkflow: () => { requested = true; } });
    await assert.rejects(adapter.applyAndGenerate({ targetNodeId: node.id, prompt: '参考图生成',
        referenceImages: [{ sourceNodeId: 'deleted' }]
    }), /参考图来源/);
    assert.equal(requested, false);
});

test('a newly created Agent target runs without any canvas selection and retries reuse the same node', async () => {
    const state = {
        nodes: new Map(), selectedNodes: new Set(),
        models: [{ id: 'image-model', modelId: 'gpt-image-test', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://example.test/v1' }]
    };
    let creations = 0;
    const nodeAdapter = createPromptAgentNodeAdapter({
        state, documentRef: { getElementById: () => null },
        createImageNode: () => {
            creations += 1;
            state.nodes.set('new-image', { id: 'new-image', type: 'ImageGenerate', data: {} });
            return 'new-image';
        }
    });
    const runs = [];
    const adapter = createPromptAgentExecutionAdapter({
        state, nodeAdapter,
        runWorkflow: async (input) => {
            runs.push(input);
            return { started: true, executed: true, nodeResults: [{ nodeId: 'new-image', images: ['new-result'] }] };
        }
    });
    const bound = nodeAdapter.ensureTarget({ prompt: '窗边的橘猫', parameters: {} }, { modelId: 'image-model' });
    assert.deepEqual(await adapter.applyAndGenerate(bound), { status: 'completed', images: ['new-result'] });
    assert.deepEqual(await adapter.applyAndGenerate(nodeAdapter.ensureTarget(bound, { modelId: 'image-model' })), { status: 'completed', images: ['new-result'] });
    assert.deepEqual(runs, [
        { mode: 'selected-only', selectedNodeIds: ['new-image'] },
        { mode: 'selected-only', selectedNodeIds: ['new-image'] }
    ]);
    assert.equal(creations, 1);
    assert.equal(state.selectedNodes.size, 0);
    assert.equal(state.nodes.get('new-image').data.prompt, '窗边的橘猫');
});

test('applies a Prompt Plan and runs only its bound image node through the existing workflow seam', async () => {
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
    await assert.rejects(() => rejected.applyAndGenerate({ targetNodeId: 'missing' }), /目标生图节点已不存在/);

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
