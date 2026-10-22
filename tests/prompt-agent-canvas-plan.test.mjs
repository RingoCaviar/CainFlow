import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan, assertCanvasPlanCurrent, promptPlanToCanvas, describeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';

const graph = (extra = {}) => createCanvasContext({ workflowId: 'workflow-a', nodes: [
    { id: 'source', type: 'ImageImport', customTitle: '产品图', mediaAssetKeys: ['media:source'], data: { apikey: 'secret' }, imageUrl: 'https://private.test/token' },
    { id: 'target', type: 'ImageGenerate', prompt: 'old', apiConfigId: 'manual', provider: { apikey: 'secret' } }
], connections: [], ...extra });
const draft = () => ({ version: 1, steps: [
    { id: 'hero', type: 'ImageGenerate', parameters: { prompt: '商品海报' } },
    { id: 'resize', type: 'ImageResize', parameters: { scalePercent: 50 } },
    { id: 'save', type: 'ImageSave', parameters: { filename: 'product' } }
], connections: [
    { from: { ref: 'source', port: 'image' }, to: { ref: 'hero', port: 'image_1' } },
    { from: { ref: 'hero', port: 'image' }, to: { ref: 'resize', port: 'image' } },
    { from: { ref: 'resize', port: 'image' }, to: { ref: 'save', port: 'image' } }
] });

test('change list preserves real line breaks and quotes instead of displaying JSON escapes', () => {
    const before = '第一行\n保留"主体"\nC:\\notes\\image.png';
    const after = '新的第一行\n新的第二行';
    const context = { nodes: [{ id: 'target', parameters: { prompt: before } }], connections: [] };
    const plan = { steps: [{ id: 'edit', nodeId: 'target', title: '编辑图片', parameters: { prompt: after } }], connections: [] };
    const snapshot = JSON.stringify({ context, plan });
    const [description] = describeCanvasPlan(plan, context);
    assert.ok(description.includes(before));
    assert.ok(description.includes(after));
    assert.ok(description.includes('修改前：\n'));
    assert.ok(description.includes('修改后：\n'));
    assert.equal(JSON.stringify({ context, plan }), snapshot);
});

test('canvas context projects public fields and pages large mixed graphs with explicit omission', () => {
    const context = graph(); const json = JSON.stringify(context.summary);
    assert.ok(!json.includes('secret')); assert.ok(!json.includes('private.test'));
    const large = graph({ nodes: Array.from({ length: 101 }, (_, i) => ({ id: `node-${i}`, type: i % 2 ? 'VideoGenerate' : 'Text', text: 'x'.repeat(3000) })) });
    const seen = []; let offset = 0;
    do { const page = large.read({ offset }); seen.push(...page.nodes); offset = page.nextOffset; } while (offset !== null);
    assert.equal(seen.length, 101); assert.equal(seen[0].parameterTextOmitted, true);
    assert.equal(seen[1].editable, false); assert.equal(large.summary.unread, true);
    assert.throws(() => large.read({ offset: -1 }));
});

test('graph plan orders dependencies, rejects unknown fields/models/ports/cycles, and requires explicit existing targets', () => {
    const context = graph(); const plan = normalizeCanvasPlan(draft(), context);
    assert.deepEqual(plan.order, ['hero', 'resize', 'save']); assert.deepEqual(plan.dependencies, ['source']);
    for (const change of [
        p => p.steps[0].parameters.apiKey = 'secret', p => p.steps[0].type = 'VideoGenerate',
        p => p.steps[0].modelId = 'automatic', p => p.connections[0].to.port = 'nonexistent',
        p => p.connections.push({ from: { ref: 'save', port: 'image' }, to: { ref: 'hero', port: 'image_2' } })
    ]) { const p = draft(); change(p); assert.throws(() => normalizeCanvasPlan(p, context)); }
    const update = { version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] };
    assert.throws(() => normalizeCanvasPlan(update, context), /@节点/);
    assert.equal(normalizeCanvasPlan(update, context, { mentionedIds: ['target'] }).steps[0].nodeId, 'target');
});

test('only relevant graph edits invalidate preview and workflow identity is fixed', () => {
    const context = graph(); const plan = normalizeCanvasPlan(draft(), context);
    context.nodes.find(node => node.id === 'target').parameters.prompt = 'unrelated';
    assert.doesNotThrow(() => assertCanvasPlanCurrent(plan, context));
    context.nodes.find(node => node.id === 'source').assets = ['media:new'];
    assert.throws(() => assertCanvasPlanCurrent(plan, context), /已变化/);
    assert.throws(() => assertCanvasPlanCurrent(plan, graph({ workflowId: 'other' })), /已变化/);
});

test('automatic saves are previewed exactly once; disabled downstreams do not suppress them', () => {
    const state = { nodes: new Map([['target', { id: 'target', type: 'ImageGenerate' }], ['disabled', { id: 'disabled', type: 'ImageSave', enabled: false }]]),
        connections: [{ from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'disabled', port: 'image' } }] };
    const adapter = createPromptAgentCanvasAdapter({ state });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] }, graph(), { mentionedIds: ['target'] });
    adapter.prepare(plan); adapter.prepare(plan);
    assert.equal(plan.steps.length, 2); assert.equal(plan.steps[1].autoAddedForGeneration, true);
    assert.equal(plan.connections[0].to.ref, 'save_edit');
    state.nodes.get('disabled').enabled = true;
    const connected = normalizeCanvasPlan({ version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] }, graph(), { mentionedIds: ['target'] });
    adapter.prepare(connected); assert.equal(connected.steps.length, 1);
});

test('multi-step models require explicit user choices and never fall back after deletion', () => {
    const first = { id: 'first', modelId: 'image-one', taskType: 'image', protocol: 'openai', providerIds: ['p'] };
    const second = { ...first, id: 'second', modelId: 'image-two' };
    const state = { models: [first, second], providers: [{ id: 'p', endpoint: 'https://example.test' }] };
    const adapter = createPromptAgentCanvasAdapter({ state }); const plan = normalizeCanvasPlan(draft(), graph());
    assert.throws(() => adapter.modelsFor(plan, ''), /手动/);
    assert.equal(adapter.modelsFor(plan, 'second').hero.model.id, 'second');
    plan.modelOverrides.hero = 'first'; assert.equal(adapter.modelsFor(plan, 'second').hero.model.id, 'first');
    state.models = [second]; assert.throws(() => adapter.modelsFor(plan, 'second'), /手动/);
    delete plan.modelOverrides.hero; state.providers = []; assert.throws(() => adapter.modelsFor(plan, 'second'));
});

test('historical pixels become fixed import assets and legacy plans retain generation patches', () => {
    const context = graph();
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'input', type: 'ImageImport', imageId: 'image-2' }] }, context,
        { images: [{ imageId: 'image-2', reference: { assetKey: 'media:result', runId: 'run' } }] });
    assert.equal(plan.steps[0].assetKey, 'media:result');
    const legacy = promptPlanToCanvas({ prompt: 'edit', parameters: { count: 2 }, referenceImages: [{ assetKey: 'media:result', runId: 'run' }] }, context);
    assert.equal(legacy.steps[0].assetKey, 'media:result'); assert.deepEqual(legacy.steps.at(-1).generationPatch, { count: 2 });
});

test('canvas plans survive archive, compact and restart without automatically resuming', () => {
    const store = createPromptAgentConversationStore(); const plan = normalizeCanvasPlan(draft(), graph());
    plan.runs.push({ id: 'attempt', status: 'running' }); plan.historyId = 'session-only';
    store.append({ role: 'agent', text: 'draft', canvasPlan: plan });
    store.compact('保留商品海报方案');
    const restored = createPromptAgentConversationStore(); restored.restore(store.snapshot(), { interruptRunning: true });
    const snapshot = restored.snapshot(); const saved = [...(snapshot.archivedMessages || []), ...snapshot.messages].find(item => item.canvasPlan).canvasPlan;
    assert.equal(saved.runs[0].status, 'interrupted'); assert.equal(saved.historyId, undefined);
    const input = createPromptAgentInput({ conversation: snapshot });
    assert.equal(JSON.parse(input.messages.at(-1).content).previousCanvasPlan.id, plan.id);
});

test('controlled model can read canvas details then return a validated plan without executing it', async () => {
    const requests = []; const payloads = [{ canvasRead: { nodeIds: ['source'] } }, { canvasPlan: draft(), message: '检查方案' }];
    const model = { id: 'chat', modelId: 'test', protocol: 'openai', providerIds: ['provider'] };
    const reply = await createPromptAgentModelReply({ message: '做商品海报', model, models: [model], canvasContext: graph(),
        providers: [{ id: 'provider', endpoint: 'https://example.test/v1', apikey: 'secret' }],
        fetchRef: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payloads.shift()) } }] })); } });
    assert.equal(requests.length, 2); assert.equal(reply.canvasPlan.steps.length, 3);
    assert.ok(JSON.stringify(requests[1]).includes('canvasReads')); assert.ok(!JSON.stringify(requests).includes('secret'));
});

test('canvas vision reads only requested local originals and stops on missing media or cancellation', async () => {
    const model = { id: 'chat', modelId: 'test', protocol: 'openai', providerIds: ['p'], autoCompactTokenLimit: 100000 };
    const pixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const requests = [], assets = [];
    const run = (getCanvasImage, signal) => createPromptAgentModelReply({ model, canvasContext: graph(), signal, getCanvasImage,
        providers: [{ id: 'p', endpoint: 'https://example.test/v1' }],
        fetchRef: async (_url, options) => {
            requests.push(JSON.parse(options.body));
            const payload = requests.length === 1 ? { canvasRead: { nodeIds: ['source'], images: [{ nodeId: 'source', index: 0 }] } }
                : { intent: 'chat', message: '已读取指定原图', promptPlan: null };
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        } });
    await run(async key => { assets.push(key); return pixels; });
    assert.deepEqual(assets, ['media:source']);
    assert.ok(!JSON.stringify(requests[0]).includes(pixels));
    assert.ok(JSON.stringify(requests[1]).includes(pixels));
    requests.length = 0;
    await assert.rejects(run(async () => null), /原图读取失败/);
    assert.equal(requests.length, 1);
    requests.length = 0;
    const controller = new AbortController();
    await assert.rejects(run(async () => { controller.abort(); return pixels; }, controller.signal), /取消/);
    assert.equal(requests.length, 1);
});

test('model graphs reject unused imports and forbidden reference input before materializing assets', () => {
    const context = graph();
    const raw = { version: 1, steps: [{ id: 'input', type: 'ImageImport', imageId: 'image-1' }, { id: 'generate', type: 'ImageGenerate', parameters: { prompt: '雪山' } }], connections: [] };
    const options = { message: '不要参考图，画雪山', images: [{ imageId: 'image-1', reference: { assetKey: 'media:source' } }], referencePolicy: { intent: 'generate' } };
    assert.throws(() => normalizeCanvasPlan(raw, context, options), /未确认/);
    raw.connections.push({ from: { ref: 'input', port: 'image' }, to: { ref: 'generate', port: 'image_1' } });
    assert.throws(() => normalizeCanvasPlan(raw, context, options), /未确认/);
    raw.steps[0].evidence = '导入产品图';
    raw.connections = [];
    assert.equal(normalizeCanvasPlan(raw, context, { ...options, message: '导入产品图' }).steps[0].type, 'ImageImport');
});

test('independent generation removes stale image inputs from an explicitly named target', () => {
    const context = graph({ connections: [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'image_1' }, type: 'image' }] });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'generation', nodeId: 'target', type: 'ImageGenerate', parameters: { prompt: '一座雪山' } }], connections: [] }, context,
        { message: '不要参考图', mentionedIds: ['target'], referencePolicy: { intent: 'generate' } });
    assert.deepEqual(plan.disconnects, [{ ref: 'generation', port: 'image_1' }]);
});
