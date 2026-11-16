import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrepareApplyPrompt } from '../js/features/prompt-agent/prompt-agent-apply-library-prompt.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import { describeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { createPromptLibraryApi } from '../js/features/prompts/prompt-library.js';
import { createCainflowAppActions } from '../js/features/canvas-mcp/cainflow-app-actions.js';
import { parseAgentAppRequest, runAgentAppRequest } from '../js/features/prompt-agent/prompt-agent-app-actions.js';

const makeContext = (nodes, connections = [], getGenerationContext) =>
    createCanvasContext({ workflowId: 'workflow', nodes, connections, getGenerationContext });
const connectPrompt = (from, to) => ({
    id: `${from}-${to}`, from: { nodeId: from, port: 'text' }, to: { nodeId: to, port: 'prompt' }, type: 'text'
});
const prepare = () => createPrepareApplyPrompt({
    promptLibrary: () => ({ getPrompt: async selector => {
        assert.deepEqual(selector, { promptId: undefined, name: '商品白底' });
        return { id: 'preset-1', name: '商品白底', content: '保留标签\n柔光' };
    } })
});

test('an ordinary preset targets the editable Text source and preserves the original input relationship', async () => {
    const context = makeContext([{ id: 'text', type: 'Text', text: '' }, { id: 'image', type: 'ImageGenerate', prompt: 'local draft' }],
        [connectPrompt('text', 'image')]);
    const { plan, appliedNodeId, target } = await prepare()({ nodeId: 'image', name: '商品白底' }, { context });
    assert.equal(appliedNodeId, 'text');
    assert.equal(target, 'prompt');
    assert.equal(plan.applyInPlace, true);
    assert.deepEqual(plan.steps.map(({ type, nodeId, parameters, execute }) => ({ type, nodeId, parameters, execute })), [
        { type: 'Text', nodeId: 'text', parameters: { text: '保留标签\n柔光' }, execute: false }
    ]);
    assert.deepEqual(new Set(plan.dependencies), new Set(['text', 'image']));
    assert.deepEqual(plan.connections, []);
    assert.deepEqual(plan.disconnects, []);
});

test('a system preset changes only the supported protocol field and rejects disabled or ambiguous sources', async () => {
    const nodes = [{ id: 'text', type: 'Text', text: 'shared' }, { id: 'image', type: 'ImageGenerate', prompt: 'local draft' },
        { id: 'other', type: 'ImageGenerate', prompt: 'unrelated' }];
    const context = makeContext(nodes, [connectPrompt('text', 'image'), connectPrompt('text', 'other')], () => ({
        parameters: { protocolParams: { systemPrompt: 'previous', output_format: 'png' } },
        parameterSchema: { protocolParams: { properties: { systemPrompt: { type: 'string' }, output_format: { type: 'string' } } } }
    }));
    const request = { nodeId: 'image', name: '商品白底' };
    await assert.rejects(prepare()(request, { context }), /共用/);
    const { plan } = await prepare()({ ...request, target: 'system' }, { context });
    assert.deepEqual(plan.steps[0].parameters, { protocolParams: { systemPrompt: '保留标签\n柔光' } });
    assert.equal(plan.libraryPrompt.expectedValue, 'previous');
    assert.equal(plan.steps[0].execute, false);
    assert.deepEqual(describeCanvasPlan(plan, context), ['图片生成 · 系统提示词\n修改前：\nprevious\n修改后：\n保留标签\n柔光']);
    await assert.rejects(prepare()({ ...request, target: 'system' }, { context: makeContext(nodes) }), /系统提示词/);
    await assert.rejects(prepare()(request, { context, isCurrent: () => false }), /变化/);
});

test('ordinary preset preview shows the effective prompt that will be replaced', async () => {
    const context = makeContext([{ id: 'image', type: 'ImageGenerate', customTitle: '首图', prompt: 'local draft' }], [],
        () => ({ prompt: '旧工作流实际使用的提示词' }));
    const { plan } = await prepare()({ nodeId: 'image', name: '商品白底' }, { context });
    assert.deepEqual(describeCanvasPlan(plan, context), ['首图 · 普通提示词\n修改前：\n旧工作流实际使用的提示词\n修改后：\n保留标签\n柔光']);
});

test('preset lookup uses exact durable identity or a unique name without choosing a search match', async () => {
    const document = [
        { id: 'first', name: '同名', content: 'first' },
        { id: 'second', name: '同名', content: 'second' },
        { id: 'detail', name: '同名细节', content: 'detail' },
        { name: '旧版预设', content: 'legacy' }
    ];
    const library = createPromptLibraryApi({
        documentRef: {}, confirmRef: () => false, localStorageRef: { readCurrentDocument: async () => ({ value: document }) }
    });
    assert.equal((await library.getPrompt({ promptId: 'second' })).content, 'second');
    assert.equal((await library.getPrompt({ name: '同名细节' })).content, 'detail');
    assert.equal((await library.getPrompt({ name: '旧版预设' })).content, 'legacy');
    await assert.rejects(library.getPrompt({ name: '同名' }), /多条/);
    await assert.rejects(library.getPrompt({ name: '细节' }), /找不到/);
    await assert.rejects(library.getPrompt({ name: '同名', promptId: 'second' }), /一个/);
    await assert.rejects(library.getPrompt({ promptId: 'legacy-prompt-3' }), /找不到/);
});

test('applying a prepared system preset rechecks the live field and edits it without a provider or a valid image source', async () => {
    const input = { tagName: 'TEXTAREA', value: 'original', dispatchEvent() {} };
    const node = { id: 'image', type: 'ImageGenerate', data: { protocolParams: { systemPrompt: 'original' } } };
    const assets = { id: 'source', type: 'ImageImport' };
    const state = { nodes: new Map([[node.id, node], [assets.id, assets]]), connections: [{
        id: 'reference', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'image', port: 'referenceImages' }
    }], selectedNodes: new Set(), models: [], providers: [] };
    let saves = 0;
    const adapter = createPromptAgentCanvasAdapter({
        state, getWorkflowId: () => 'workflow',
        serializeNodes: () => [node, assets],
        documentRef: { body: { children: [] }, defaultView: { Event },
            getElementById: id => id === 'image-param-systemPrompt' ? input : null },
        nodeAdapter: { getContext: () => ({
            parameters: { protocolParams: { systemPrompt: input.value } },
            parameterSchema: { protocolParams: { properties: { systemPrompt: { type: 'string' } } } }
        }) },
        session: () => ({ async applyCanvasBatch(mutate, persist) { await mutate(); await persist(); return { historyId: 'change' }; } }),
        save: () => { saves++; return true; }, graphChanged() {}, origin: () => ({ x: 0, y: 0 })
    });
    const request = { nodeId: 'image', name: '商品白底', target: 'system' };
    const { plan } = await prepare()(request, { context: adapter.context() });
    input.value = 'changed while previewing';
    await assert.rejects(adapter.apply(plan), /变化/);
    assert.equal(input.value, 'changed while previewing');
    const { plan: current } = await prepare()(request, { context: adapter.context() });
    await adapter.apply(current);
    assert.equal(input.value, '保留标签\n柔光');
    assert.equal(saves, 1);
    assert.equal(current.historyId, 'change');
    assert.equal(state.connections[0].id, 'reference');
});

test('Agent and MCP apply the two native TextChat prompt fields without changing the configured model', async () => {
    const node = { id: 'chat', type: 'TextChat', customTitle: '文案助手', apiConfigId: 'configured-chat', providerId: 'configured-provider' };
    const other = { ...node, id: 'other' };
    const fields = { prompt: '旧问题', sysprompt: '原角色' };
    const controls = Object.fromEntries(Object.entries(fields).map(([suffix, value]) => [`chat-${suffix}`, {
        tagName: 'TEXTAREA', value, dispatchEvent() { fields[suffix] = this.value; }
    }]));
    const state = { nodes: new Map([[node.id, node], [other.id, other]]), connections: [],
        selectedNodes: new Set([other.id]), models: [], providers: [] };
    let saves = 0;
    const adapter = createPromptAgentCanvasAdapter({ state, getWorkflowId: () => 'workflow',
        serializeNodes: () => [{ ...node, ...fields }, other],
        documentRef: { body: { children: [] }, defaultView: { Event }, getElementById: id => controls[id] },
        session: () => ({ async applyCanvasBatch(mutate, persist) { await mutate(); await persist(); return { historyId: 'change' }; } }),
        save: () => { saves++; return true; }, graphChanged() {}, origin: () => ({ x: 0, y: 0 }) });
    const actions = createCainflowAppActions({ prepareApplyPrompt: prepare(),
        applyCanvasPlan: (plan, isCurrent) => adapter.apply(plan, undefined, () => {}, isCurrent) });

    const agentRequest = parseAgentAppRequest('把库里的「商品白底」套用到 @文案助手[chat] 的系统提示词');
    const { canvasPlan } = await runAgentAppRequest(agentRequest, actions, { context: adapter.context() });
    assert.equal(canvasPlan.steps[0].nodeId, node.id);
    assert.deepEqual(canvasPlan.steps[0].parameters, { sysprompt: '保留标签\n柔光' });
    assert.equal(canvasPlan.steps[0].execute, false);
    assert.deepEqual(describeCanvasPlan(canvasPlan, adapter.context()), ['文案助手 · 系统提示词\n修改前：\n原角色\n修改后：\n保留标签\n柔光']);
    assert.deepEqual(fields, { prompt: '旧问题', sysprompt: '原角色' });
    await adapter.apply(canvasPlan);
    assert.deepEqual(fields, { prompt: '旧问题', sysprompt: '保留标签\n柔光' });

    const applied = await actions.dispatch('apply_prompt', { nodeId: 'chat', name: '商品白底' }, { context: adapter.context() });
    assert.equal(applied.appliedNodeId, node.id);
    assert.equal(fields.prompt, '保留标签\n柔光');
    assert.equal(node.apiConfigId, 'configured-chat');
    assert.equal(node.providerId, 'configured-provider');
    assert.equal(saves, 2);
});

test('ordinary TextChat presets follow a unique upstream Text and preserve shared input conflicts', async () => {
    const nodes = [{ id: 'text', type: 'Text', text: '共享模板' }, { id: 'chat', type: 'TextChat' }, { id: 'image', type: 'ImageGenerate' }];
    const connection = connectPrompt('text', 'chat');
    const request = { nodeId: 'chat', name: '商品白底' };
    const { plan, appliedNodeId } = await prepare()(request, { context: makeContext(nodes, [connection]) });
    assert.equal(appliedNodeId, 'text');
    assert.deepEqual(plan.steps[0].parameters, { text: '保留标签\n柔光' });
    assert.deepEqual(plan.connections, []);
    await assert.rejects(prepare()(request, { context: makeContext(nodes, [connection, connectPrompt('text', 'image')]) }), /共用/);
});
