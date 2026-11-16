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
