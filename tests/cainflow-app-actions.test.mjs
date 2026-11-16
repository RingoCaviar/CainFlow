import assert from 'node:assert/strict';
import test from 'node:test';
import { createCainflowAppActions } from '../js/features/canvas-mcp/cainflow-app-actions.js';
import { parseAgentAppRequest, runAgentAppRequest } from '../js/features/prompt-agent/prompt-agent-app-actions.js';

test('the same typed operations back direct Agent requests and delegated application tools', async () => {
    const writes = [];
    const actions = createCainflowAppActions({
        createEmptyWorkflow: async ({ name }) => ({ name, workflowId: 'workflow-empty' }),
        listHistoryImages: async () => ({ items: [{ id: 42, fileVersion: 'version-1' }] }),
        annotateHistoryImage: async args => { writes.push(args); return args; },
        promptLibrary: () => ({ upsertPrompt: async args => { writes.push(args); return args; } })
    });
    assert.match(await runAgentAppRequest(parseAgentAppRequest('新建一个空白工作流，命名为「商品评审」'), actions), /商品评审/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('给最新一张历史图片加备注：正面样片'), actions), /正面样片/);
    await actions.dispatch('annotate_history', { id: 42, fileVersion: 'version-2', note: '' });
    assert.match(await runAgentAppRequest(parseAgentAppRequest('保存提示词「白底规则」：保留包装文字\n使用柔光'), actions), /白底规则/);
    assert.deepEqual(writes, [
        { id: 42, fileVersion: 'version-1', note: '正面样片' },
        { id: 42, fileVersion: 'version-2', note: '' },
        { name: '白底规则', content: '保留包装文字\n使用柔光' }
    ]);
});

test('cancellation and arbitrary paths or operations cannot become application commands', async () => {
    const calls = [];
    const actions = createCainflowAppActions({ createEmptyWorkflow: async args => calls.push(args) });
    assert.equal(parseAgentAppRequest('先讨论怎么新建空白工作流'), null);
    assert.equal(parseAgentAppRequest('不要新建一个空白工作流'), null);
    assert.equal(parseAgentAppRequest('他说「新建一个空白工作流」'), null);
    assert.deepEqual(parseAgentAppRequest('请把「白底并保留标签」保存到提示词库，命名为「白底预设」。'),
        { method: 'save_prompt', args: { name: '白底预设', content: '白底并保留标签' } });
    await assert.rejects(actions.dispatch('create_workflow', { path: 'outside' }), /参数/);
    await assert.rejects(actions.dispatch('create_workflow', { name: 'test' }, { isCurrent: () => false }), /变化/);
    await assert.rejects(actions.dispatch('shell', { command: 'invalid' }), /应用操作/);
    assert.deepEqual(calls, []);
});

test('local history and preset commands resolve exact app identities before reaching the shared edit', async () => {
    const calls = [];
    const context = { workflowId: 'w', summary: { selectedIds: ['hero'] }, nodes: [{ id: 'hero', name: '主图' }] };
    const options = { context, isCurrent: () => true };
    const actions = createCainflowAppActions({
        listHistoryImages: async ({ id }) => ({ items: [{ id, fileVersion: '100:200' }] }),
        importHistory: async args => { calls.push(args); return { imported: args.items }; },
        prepareApplyPrompt: async args => { calls.push(args); return { plan: { workflowId: 'w' }, promptName: args.name }; }
    });
    const imported = parseAgentAppRequest('把历史图片 ID 42、-53 导入当前画布');
    assert.match(await runAgentAppRequest(imported, actions, options), /已导入 2 张/);
    const preset = parseAgentAppRequest('把库里的「白底规则」套用到选中节点的系统提示词');
    assert.deepEqual((await runAgentAppRequest(preset, actions, options)).canvasPlan, { workflowId: 'w' });
    const namedPreset = parseAgentAppRequest('把库里的「白底规则」套用到节点「主图」的普通提示词');
    assert.deepEqual((await runAgentAppRequest(namedPreset, actions, options)).canvasPlan, { workflowId: 'w' });
    assert.deepEqual(calls, [
        { items: [{ id: 42, fileVersion: '100:200' }, { id: -53, fileVersion: '100:200' }] },
        { name: '白底规则', nodeId: 'hero', target: 'system' },
        { name: '白底规则', nodeId: 'hero', target: 'prompt' }
    ]);
    const duplicate = { ...context, nodes: [...context.nodes, { id: 'second', name: '主图' }] };
    await assert.rejects(runAgentAppRequest(parseAgentAppRequest('把库里的「白底规则」套用到「主图」的提示词'),
        actions, { ...options, context: duplicate }), /同名/);
    await assert.rejects(runAgentAppRequest(namedPreset, actions, { ...options, context: duplicate }), /同名/);
});

test('execution and history commands act on the captured workflow and selected node IDs', async () => {
    const calls = [];
    const options = { context: { workflowId: 'scene-one', summary: { selectedIds: ['b'] },
        nodes: [{ id: 'a', name: '接收提示词' }, { id: 'b', name: '出图' }] } };
    const actions = createCainflowAppActions({
        runCanvas: async (input, scope) => { calls.push([scope.context.workflowId, input]); return true; },
        stopCanvas: async (nodeIds, scope) => { calls.push([scope.context.workflowId, nodeIds]); return 1; },
        changeCanvasHistory: async (method, scope) => { calls.push([scope.context.workflowId, method]); return true; }
    });
    assert.match(await runAgentAppRequest(parseAgentAppRequest('运行选中的节点'), actions, options), /已启动/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('运行到「接收提示词」'), actions, options), /已启动/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('停止选中节点'), actions, options), /停止/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('运行节点「出图」'), actions, options), /已启动/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('停止 @接收提示词[a]'), actions, options), /停止/);
    assert.match(await runAgentAppRequest(parseAgentAppRequest('撤销上一步'), actions, options), /已撤销/);
    assert.deepEqual(calls, [
        ['scene-one', { mode: 'selected-only', selectedNodeIds: ['b'] }],
        ['scene-one', { mode: 'target-node', targetNodeId: 'a' }],
        ['scene-one', ['b']], ['scene-one', { mode: 'selected-only', selectedNodeIds: ['b'] }],
        ['scene-one', ['a']], ['scene-one', 'undo']
    ]);
    await assert.rejects(actions.dispatch('stop_workflow', { nodeIds: ['elsewhere'] }, options), /当前工作流/);
});
