import { layoutIndependentCanvasNodes } from '../js/features/prompt-agent/prompt-agent-canvas-batches.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCanvasPlanRecreation } from '../js/features/prompt-agent/prompt-agent-canvas-recreation.js';
import { createCanvasContext, canvasBaseline } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan, assertCanvasPlanCurrent, promptPlanToCanvas, describeCanvasPlan, isSelectedReferenceClearRequest,
    createSelectedReferenceClearReply } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import { canvasRevisionFingerprint } from '../js/features/canvas-mcp/cainflow-app-actions.js';

const graph = (extra = {}) => createCanvasContext({ workflowId: 'workflow-a', nodes: [
    { id: 'source', type: 'ImageImport', customTitle: '产品图', mediaAssetKeys: ['media:source'], data: { apikey: 'secret' }, imageUrl: 'https://private.test/token' },
    { id: 'target', type: 'ImageGenerate', prompt: 'old', apiConfigId: 'manual', provider: { apikey: 'secret' } }
], connections: [], ...extra });
const draft = () => ({ version: 1, steps: [
    { id: 'hero', type: 'ImageGenerate', parameters: { prompt: '商品海报' } },
    { id: 'resize', type: 'ImageResize', parameters: { scalePercent: 50 } },
    { id: 'save', type: 'ImagePreview', parameters: {} }
], connections: [
    { from: { ref: 'source', port: 'image' }, to: { ref: 'hero', port: 'image_1' } },
    { from: { ref: 'hero', port: 'image' }, to: { ref: 'resize', port: 'image' } },
    { from: { ref: 'resize', port: 'image' }, to: { ref: 'save', port: 'image' } }
] });

test('the current selection can be revised or deleted while new work remains independent of it', () => {
    const context = graph({ selectedIds: ['target'] });
    const update = normalizeCanvasPlan({ version: 1, steps: [{ id: 'revise', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] }, context, { message: '优化选中的节点' });
    assert.equal(update.steps[0].nodeId, 'target');
    assert.equal(normalizeCanvasPlan(draft(), context).steps[0].nodeId, undefined, 'selection does not force new steps to modify it');
    const deletion = normalizeCanvasPlan({ version: 1, steps: [], deletes: [{ nodeId: 'target' }] }, context, { message: '删除选中的节点' });
    assert.deepEqual(deletion.deletes.map(item => item.nodeId), ['target']);
    assert.ok(describeCanvasPlan(deletion, context).some(line => line.includes('删除') && line.includes('target')));
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [], deletes: [{ nodeId: 'source' }] }, context), /选中|@节点/);
});

test('canvas plans validate explicitly targeted commerce product information and copy language edits', () => {
    const node = { id: 'commerce', type: 'ECommerceImageSet',
        mediaAssetKeys: ['media:current'],
        commerceImageSet: { platformId: 'amazon', selectedShotIds: ['feature'],
            productInfo: { name: '旧名称', sellingPoints: ['可见杯盖'] },
            copyLanguage: 'en', autoProductInfo: { name: '旧名称' }, plannerProviderId: 'private-config',
            candidateCount: 3,
            plan: { version: 1, platformId: 'amazon', sourceKey: 'references', confirmed: true,
                sellingPoints: [], shots: [{ id: 'feature', prompt: '当前方案' }], copyLanguage: 'en' },
            results: [{ shotId: 'feature', status: 'completed', assetKey: 'media:current', finalized: true }],
            candidates: [{ shotId: 'feature', assetKey: 'media:archived-shot', aspect: '1:1', draft: { prompt: '私有候选提示词' } }] } };
    const context = graph({ nodes: [node], selectedIds: [node.id] });
    assert.deepEqual(context.summary.editableFields.ECommerceImageSet, ['productInfo', 'copyLanguage']);
    assert.deepEqual(context.nodes[0].parameters, { copyLanguage: 'en', productInfo: { name: '旧名称', sellingPoints: ['可见杯盖'] } });
    assert.doesNotMatch(JSON.stringify(context.summary), /archived-shot|私有候选提示词|finalized|candidateCount|commerceRunSettings/);
    const changedCount = graph({ nodes: [{ ...node, commerceImageSet: { ...node.commerceImageSet, candidateCount: 8 } }],
        selectedIds: [node.id] });
    assert.deepEqual(changedCount.read(), context.read());
    assert.notEqual(canvasRevisionFingerprint(changedCount), canvasRevisionFingerprint(context));
    const unlocked = graph({ nodes: [{ ...node, commerceImageSet: { ...node.commerceImageSet,
        results: node.commerceImageSet.results.map(result => ({ ...result, finalized: false })) } }], selectedIds: [node.id] });
    assert.deepEqual(unlocked.summary, context.summary);
    assert.notEqual(canvasRevisionFingerprint(unlocked), canvasRevisionFingerprint(context));
    assert.ok(context.nodes[0].parameterOptions.copyLanguage.includes('ja'));
    const raw = (parameters, options = {}) => ({ version: 1, steps: [{ id: 'edit', type: node.type,
        nodeId: node.id, parameters, execute: false, ...options }] });
    const parameters = { productInfo: { name: '随行杯', sellingPoints: [] }, copyLanguage: 'ja' };
    const plan = normalizeCanvasPlan(raw(parameters), context, { message: '修改选中的商品信息和图中文字语言' });
    assert.deepEqual(plan.steps[0].parameters, parameters);
    assert.match(describeCanvasPlan(plan, context).join('\n'), /商品名称：旧名称 → 随行杯/);
    assert.match(describeCanvasPlan(plan, context).join('\n'), /图中文字语言：英[语文] → 日[语文]/);
    assert.throws(() => normalizeCanvasPlan(raw(parameters), graph({ nodes: [node] })), /选中|@节点/);
    assert.throws(() => normalizeCanvasPlan(raw(parameters, { execute: true }), context), /execute: false/);
    assert.throws(() => normalizeCanvasPlan(raw({ candidateCount: 8 }), context), /不支持参数.*candidateCount/);
    for (const invalid of [{ name: 1 }, { sellingPoints: '可见杯盖' }, { details: 'x'.repeat(4001) }, { providerId: 'other' }]) {
        assert.throws(() => normalizeCanvasPlan(raw({ productInfo: invalid }), context), /商品信息/);
    }
    for (const invalid of ['invalid-language', 123]) {
        assert.throws(() => normalizeCanvasPlan(raw({ copyLanguage: invalid }), context), /copyLanguage/);
    }
    const legacy = graph({ nodes: [{ ...node, commerceImageSet: { ...node.commerceImageSet, copyLanguage: undefined } }] });
    assert.equal(legacy.read().nodes[0].parameters.copyLanguage, 'auto');
    assert.doesNotMatch(canvasBaseline(legacy, [node.id]), /copyLanguage/, 'automatic mode keeps persisted v1 plan baselines');
    assert.match(canvasBaseline(context, [node.id]), /"copyLanguage":"en"/, 'explicit edits invalidate a planned language change');
});

test('clearing references needs an explicit selected-node command and preserves other inputs, including masks', () => {
    assert.equal(isSelectedReferenceClearRequest('把我选中节点的参考图都移除'), true);
    assert.equal(isSelectedReferenceClearRequest('请断开当前选中的生图节点的所有参考图连线。'), true);
    for (const message of ['不要把选中节点的参考图都移除', '怎么清空选中节点的参考图', '移除选中节点的第1张参考图', '移除选中节点的参考图后运行']) {
        assert.equal(isSelectedReferenceClearRequest(message), false, message);
    }
    const edges = ['image_1', 'referenceImages', 'mask'].map((port, index) => ({ id: `edge-${index}`, order: index,
        from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port } }));
    assert.match(createSelectedReferenceClearReply(graph({ selectedIds: ['source'] })).message, /选中.*生图节点/);
    assert.match(createSelectedReferenceClearReply(graph({ selectedIds: ['target'] })).message, /没有已连接的参考图/);
    const running = graph({ selectedIds: ['target'], connections: edges, runningIds: ['target'] });
    assert.match(createSelectedReferenceClearReply(running).message, /正在运行/);
    const context = graph({ selectedIds: ['source', 'target'], connections: edges });
    const { canvasPlan: plan } = createSelectedReferenceClearReply(context);
    assert.equal(plan.applyInPlace, true);
    assert.deepEqual(plan.steps.map(step => [step.nodeId, step.execute]), [['target', false]]);
    assert.deepEqual(projectPlanConnections(plan, context.connections, ref => plan.steps.find(step => step.id === ref)?.nodeId || ref), [context.connections[2]]);
    assert.equal(describeCanvasPlan(plan, context).filter(line => line.includes('移除连线')).length, 2);
    assert.throws(() => assertCanvasPlanCurrent(plan, graph({ selectedIds: ['target'], connections: edges.slice(1) })), /重新发送原指令/);
});

test('deletions preview their edge impact, preserve other reference order, and reject conflicts or running neighbors', () => {
    const nodes = [{ id: 'one', type: 'ImageImport' }, { id: 'two', type: 'ImageImport' }, { id: 'target', type: 'ImageGenerate', prompt: 'before' }];
    const connections = ['one', 'two'].map((id, order) => ({ id: `edge-${id}`, from: { nodeId: id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, order: order + 4 }));
    const context = graph({ nodes, connections, selectedIds: ['one', 'target'] });
    const raw = { version: 1, steps: [{ id: 'revise', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'after' } }], deletes: [{ nodeId: 'one' }] };
    const plan = normalizeCanvasPlan(raw, context, { message: '优化目标，删除多余的来源' });
    const links = projectPlanConnections(plan, connections, ref => ref === 'revise' ? 'target' : ref);
    assert.deepEqual(links, [connections[1]], 'the remaining edge keeps its identity and order');
    assert.ok(describeCanvasPlan(plan, context).some(line => line.includes('移除连线')));
    assert.throws(() => normalizeCanvasPlan({ ...raw, deletes: [{ nodeId: 'target' }] }, context), /同时修改和删除/);
    assert.throws(() => normalizeCanvasPlan(raw, graph({ nodes, connections, selectedIds: ['one', 'target'], runningIds: ['target'] })), /正在运行/);
    assert.throws(() => assertCanvasPlanCurrent(plan, graph({ nodes, connections: [], selectedIds: [] })), /变化/);
});

test('refreshing a deletion preview includes newly affected connections before allowing application', () => {
    const nodes = [{ id: 'remove', type: 'Text', customTitle: '旧名称', text: 'text' }, { id: 'target', type: 'ImageGenerate' }];
    const state = { nodes: new Map(nodes.map(node => [node.id, node])), connections: [], selectedNodes: new Set(['remove']), runningNodeIds: new Set() };
    const adapter = createPromptAgentCanvasAdapter({ state, serializeNodes: () => nodes, getWorkflowId: () => 'workflow-a' });
    const plan = normalizeCanvasPlan({ version: 1, steps: [], deletes: [{ nodeId: 'remove' }] }, adapter.context());
    state.connections.push({ id: 'new-edge', from: { nodeId: 'remove', port: 'text' }, to: { nodeId: 'target', port: 'prompt' } });
    nodes[0].customTitle = '新名称';
    adapter.refresh(plan);
    assert.equal(plan.deletes[0].title, '新名称');
    assert.ok(describeCanvasPlan(plan, adapter.context()).some(line => line.includes('移除连线') && line.includes('提示词')));
    assertCanvasPlanCurrent(plan, adapter.context());
});

test('refreshing a mixed applied plan preserves completed deletion but re-enables its parameter changes', () => {
    const nodes = [{ id: 'remove', type: 'Text', text: 'remove' }, { id: 'keep', type: 'Text', text: 'before' }];
    const state = { nodes: new Map(nodes.map(node => [node.id, node])), connections: [], selectedNodes: new Set(['remove', 'keep']), runningNodeIds: new Set() };
    const adapter = createPromptAgentCanvasAdapter({ state, serializeNodes: () => [...state.nodes.values()], getWorkflowId: () => 'workflow-a' });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'revise', type: 'Text', nodeId: 'keep', parameters: { text: 'after' } }], deletes: [{ nodeId: 'remove' }] }, adapter.context());
    state.nodes.delete('remove');
    state.nodes.get('keep').text = 'manual change';
    plan.appliedSignature = 'already-applied'; plan.completedDeletions = ['remove']; plan.bindings = { revise: 'keep' };
    adapter.refresh(plan);
    assert.equal(plan.appliedSignature, undefined, 'a mixed proposal must apply its previewed text change again');
    adapter.refresh(plan);
    assert.ok(describeCanvasPlan(plan, adapter.context()).some(line => line.includes('manual change → after')));
});

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

test('node patches validate precise existing targets and preserve the send-time position', () => {
    const node = { id: 'video', type: 'VideoGenerate', customTitle: '原节点', x: 100, y: 200, enabled: false };
    const context = graph({ nodes: [node], selectedIds: ['video'] });
    const step = { id: 'patch', type: 'VideoGenerate', nodeId: 'video', patch: { title: '新版', x: -25, y: 60, enabled: true } };
    const proposal = { version: 1, steps: [step] };
    const plan = normalizeCanvasPlan(proposal, context);
    assert.deepEqual(plan.steps[0].patch, step.patch);
    assert.equal(plan.steps[0].execute, false);
    assert.equal(plan.applyInPlace, true);
    assert.equal(context.nodes[0].patchable, true);
    assert.match(describeCanvasPlan(plan, context).join('\n'), /原节点 → 新版/);
    assert.match(describeCanvasPlan(plan, context).join('\n'), /100, 200 → -25, 60/);
    assert.match(describeCanvasPlan(plan, context).join('\n'), /停用 → 启用/);
    assert.throws(() => assertCanvasPlanCurrent(plan, graph({ nodes: [{ ...node, x: 111 }] })), /变化/);
    for (const bad of [{ ...step, patch: { enabled: 'true' } }, { ...step, patch: { filePath: 'C:/anything' } },
        { ...step, patch: { x: Infinity } }, { ...step, patch: { title: 'x'.repeat(101) } },
        { ...step, nodeId: undefined }, { ...step, patch: { ...step.patch, enabled: false }, execute: true }]) {
        assert.throws(() => normalizeCanvasPlan({ ...proposal, steps: [bad] }, context));
    }
    assert.throws(() => normalizeCanvasPlan(proposal, graph({ nodes: [node] })), /@节点/);
    assert.throws(() => normalizeCanvasPlan(proposal, graph({ nodes: [node], selectedIds: ['video'], runningIds: ['video'] })), /正在运行/);
    assert.throws(() => normalizeCanvasPlan(proposal, graph({ nodes: [{ ...node, isClone: true }], selectedIds: ['video'] })), /只读/);
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [step, { ...step, id: 'another' }] }, context), /重复/);
});

test('registered node shells can be created without running or accepting arbitrary settings', () => {
    const context = graph();
    for (const type of ['ImageGenerate', 'ImageCompare', 'VideoGenerate', 'TextChat', 'ProductRetouch', 'CustomParams']) {
        const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'shell', type, execute: false }] }, context);
        assert.equal(plan.steps[0].execute, false);
        assert.ok(context.summary.creatableTypes.includes(type));
    }
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [{ id: 'shell', type: 'ProductRetouch' }] }, context));
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [{ id: 'shell', type: 'VideoGenerate', execute: false,
        parameters: { endpoint: 'https://example.test' } }] }, context));
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [{ id: 'shell', type: 'ImageSave', execute: false }] }, context));
});

test('a stopped node can be edited without implicitly enabling or running it', () => {
    const node = { id: 'text', type: 'Text', text: 'before', enabled: false };
    const context = graph({ nodes: [node], selectedIds: [node.id] });
    const step = { id: 'revise', type: 'Text', nodeId: node.id, parameters: { text: 'after' }, execute: false };
    const plan = normalizeCanvasPlan({ version: 1, steps: [step] }, context);
    assert.equal(plan.steps[0].execute, false);
    assert.equal(plan.steps[0].patch, undefined);
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [{ ...step, execute: true }] }, context), /停用/);
});

test('canvas context projects public fields and pages large mixed graphs with explicit omission', () => {
    const context = graph(); const json = JSON.stringify(context.summary);
    assert.ok(!json.includes('secret')); assert.ok(!json.includes('private.test'));
    const large = graph({ nodes: Array.from({ length: 101 }, (_, i) => ({ id: `node-${i}`, type: i % 2 ? 'ProductRetouch' : 'Text', text: 'x'.repeat(3000) })) });
    const seen = []; let offset = 0;
    do { const page = large.read({ offset }); seen.push(...page.nodes); offset = page.nextOffset; } while (offset !== null);
    assert.equal(seen.length, 101); assert.equal(seen[0].parameterTextOmitted, true);
    assert.equal(seen[1].editable, false); assert.equal(large.summary.unread, true);
    assert.throws(() => large.read({ offset: -1 }));
});

test('ordinary canvas fields validate native values and preserve a wired prompt source', () => {
    const nodes = [
        { id: 'chat', type: 'TextChat', prompt: 'local fallback', sysprompt: 'system', fixed: false },
        { id: 'video', type: 'VideoGenerate', prompt: 'scene', aspect: '16:9', generationCount: 1 },
        { id: 'color', type: 'ColorReset', whiteBalanceMode: 'original', temperature: 0 },
        { id: 'split', type: 'TextSplit', previewEnabled: true },
        { id: 'source', type: 'Text', text: 'wired prompt' }
    ];
    const context = createCanvasContext({ workflowId: 'scoped-scalars', nodes,
        selectedIds: nodes.map(node => node.id), getVideoAspects: () => ['16:9', '9:16'],
        connections: [{ id: 'wired', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'chat', port: 'prompt' } }]
    });
    const propose = (nodeId, parameters) => normalizeCanvasPlan({ version: 1, steps: [{
        id: 'edit', nodeId, type: nodes.find(node => node.id === nodeId).type, execute: false, parameters
    }] }, context);
    const readings = context.read().nodes;
    assert.equal(readings.find(node => node.id === 'chat').supportsSystemPrompt, true);
    assert.deepEqual(readings.find(node => node.id === 'video').parameterOptions.aspect, ['16:9', '9:16']);
    for (const [id, parameters] of [
        ['chat', { sysprompt: 'revision', fixed: true }],
        ['video', { prompt: 'new scene', aspect: '9:16', generationCount: 3 }],
        ['color', { whiteBalanceMode: 'auto', temperature: -100, tint: 30, vibrance: -5, saturation: 100 }],
        ['split', { previewEnabled: false }]
    ]) assert.deepEqual(propose(id, parameters).steps[0].parameters, parameters);
    for (const [id, parameters] of [
        ['chat', { fixed: 'true' }], ['chat', { search: true }],
        ['video', { aspect: '4:3' }], ['video', { generationCount: 1.5 }], ['video', { endpoint: 'https://provider.test' }],
        ['color', { temperature: -101 }], ['color', { whiteBalanceMode: 'custom' }],
        ['split', { previewEnabled: 1 }], ['split', { outputCount: 2 }]
    ]) assert.throws(() => propose(id, parameters));
    assert.throws(() => propose('chat', { prompt: 'not used' }), /已接入上游/);
});

test('registered dynamic text sockets are projected, writable and checked against the current layout', () => {
    const split = { id: 'split', type: 'TextSplit', outputCount: 3 };
    const merge = { id: 'merge', type: 'TextMerge', inputCount: 2 };
    const context = graph({ nodes: [split, merge], selectedIds: [merge.id] });
    assert.deepEqual(context.read().nodes.map(node => [node.inputs.map(port => port.name), node.outputs.map(port => port.name)]), [
        [['text'], ['part_1', 'part_2', 'part_3']], [['text_1', 'text_2'], ['text']]
    ]);
    const wiring = (from, to) => ({ version: 1, steps: [{ id: 'target', type: merge.type, nodeId: merge.id }],
        connections: [{ from: { ref: split.id, port: from }, to: { ref: 'target', port: to } }] });
    const plan = normalizeCanvasPlan(wiring('part_3', 'text_2'), context);
    assert.equal(plan.steps[0].execute, false);
    assertCanvasPlanCurrent(plan, context);
    assert.throws(() => normalizeCanvasPlan(wiring('part_4', 'text_2'), context), /端口/);
    assert.throws(() => normalizeCanvasPlan(wiring('part_3', 'text_3'), context), /端口/);
    const combined = graph({ nodes: [{ ...split, mergeOutputEnabled: true }, merge], selectedIds: [merge.id] });
    assert.throws(() => assertCanvasPlanCurrent(plan, combined), /已变化/);
    assert.doesNotThrow(() => normalizeCanvasPlan(wiring('text', 'text_2'), combined));
});

test('changing an existing merge count preserves present wires or requires their explicit removal', () => {
    const nodes = [{ id: 'source', type: 'ImageImport' }, { id: 'merge', type: 'ImageMerge', inputCount: 4 }];
    const connections = [1, 3].map(index => ({ id: `wire${index}`,
        from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'merge', port: `image_${index}` } }));
    const context = graph({ nodes, connections, selectedIds: ['merge'] });
    const resized = count => ({ version: 1, steps: [{ id: 'resize-ports', type: 'ImageMerge', nodeId: 'merge',
        parameters: { inputCount: count }, execute: false }] });
    assert.doesNotThrow(() => normalizeCanvasPlan(resized(5), context));
    assert.throws(() => normalizeCanvasPlan(resized(2), context), /保留现有连线/);
    const plan = normalizeCanvasPlan({ ...resized(2), disconnects: [{ ref: 'resize-ports', port: 'image_3', connectionId: 'wire3' }] },
        context, { explicitInputChanges: true });
    assert.deepEqual(projectPlanConnections(plan, connections, ref => ref === 'resize-ports' ? 'merge' : ref).map(edge => edge.id), ['wire1']);
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
    assert.throws(() => assertCanvasPlanCurrent(plan, context), /下方 Agent 输入框发送“根据当前画布重新生成方案”/);
    assert.throws(() => assertCanvasPlanCurrent(plan, graph({ workflowId: 'other' })), /已变化/);
});

test('preparing a plan never appends saves and preserves explicitly requested saves', () => {
    const state = { nodes: new Map([['target', { id: 'target', type: 'ImageGenerate' }], ['disabled', { id: 'disabled', type: 'ImageSave', enabled: false }]]),
        connections: [{ from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'disabled', port: 'image' } }] };
    const adapter = createPromptAgentCanvasAdapter({ state });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] }, graph(), { mentionedIds: ['target'] });
    adapter.prepare(plan); adapter.prepare(plan);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.connections.length, 0);
    state.nodes.get('disabled').enabled = true;
    const connected = normalizeCanvasPlan({ version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'new' } }] }, graph(), { mentionedIds: ['target'] });
    adapter.prepare(connected); assert.equal(connected.steps.length, 1);
    const namedSave = { steps: [
        { id: 'new', type: 'ImageGenerate', title: '宠物照片', parameters: {} },
        { id: 'save', type: 'ImageSave', title: '我的成品', parameters: {} }
    ], connections: [{ from: { ref: 'new', port: 'image' }, to: { ref: 'save', port: 'image' }, type: 'image' }], order: ['new', 'save'] };
    adapter.prepare(namedSave);
    assert.equal(namedSave.steps.length, 2);
    assert.equal(namedSave.steps[1].title, '我的成品', 'explicitly named save steps retain their title');
});

test('applying new canvas nodes focuses one after save and does not refocus on repeat', async () => {
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: { zoom: 1 }, models: [], providers: [] };
    const events = [];
    let nextId = 0;
    const documentRef = { body: { children: [] }, defaultView: { Event: class {} }, getElementById: () => ({
        value: '', dispatchEvent() {}
    }) };
    const adapter = createPromptAgentCanvasAdapter({ state, documentRef,
        serializeNodes: () => [...state.nodes.values()], getWorkflowId: () => 'workflow-a',
        addNode: (type, x, y, data) => {
            const id = `new-${++nextId}`;
            state.nodes.set(id, { id, type, x, y, width: 260, height: 190, data, text: data.text, customTitle: data.customTitle });
            return id;
        },
        session: () => ({ applyCanvasBatch: async (mutate, persist) => {
            const result = await mutate();
            await persist();
            return { ...result, historyId: 'history-a' };
        } }),
        save: async () => { events.push('save'); return true; }, graphChanged: () => {},
        origin: () => ({ x: 100, y: 100 }), focusNode: id => events.push(`focus:${id}`)
    });
    const plan = normalizeCanvasPlan({ version: 1, steps: [
        { id: 'first', type: 'Text', parameters: { text: 'first' } },
        { id: 'second', type: 'Text', parameters: { text: 'second' } }
    ] }, createCanvasContext({ workflowId: 'workflow-a', nodes: [], connections: [] }));
    await adapter.apply(plan, '');
    assert.deepEqual(events, ['save', 'focus:new-1']);
    await adapter.apply(plan, '');
    assert.deepEqual(events, ['save', 'focus:new-1', 'save']);
});

test('multi-step models require explicit user choices and never fall back after deletion', () => {
    const first = { id: 'first', modelId: 'image-one', taskType: 'image', protocol: 'openai', providerIds: ['p'] };
    const second = { ...first, id: 'second', modelId: 'image-two' };
    const state = { models: [first, second], providers: [{ id: 'p', endpoint: 'https://example.test', apikey: 'controlled-key' }] };
    const adapter = createPromptAgentCanvasAdapter({ state }); const plan = normalizeCanvasPlan(draft(), graph());
    assert.throws(() => adapter.modelsFor(plan, ''), /手动/);
    plan.agentProviders = {first:'p',second:'p'};
    assert.equal(adapter.modelsFor(plan, 'second').hero.model.id, 'second');
    plan.modelOverrides.hero = 'first'; assert.equal(adapter.modelsFor(plan, 'second').hero.model.id, 'first');
    state.models = [second]; assert.throws(() => adapter.modelsFor(plan, 'second'), /手动/);
    delete plan.modelOverrides.hero; state.providers = []; assert.throws(() => adapter.modelsFor(plan, 'second'));
});

test('retired Agent image thinking preferences are ignored while model defaults and step overrides remain', () => {
    const image = { id: 'gem', modelId: 'gemini-3.1-flash-image-preview', taskType: 'image', protocol: 'google', providerIds: ['p'],
        thinking: { profile: 'google-image', default: { mode: 'level', value: 'minimal' } } };
    const state = { models: [image], providers: [{ id: 'p', endpoint: 'https://generativelanguage.googleapis.com', apikey: 'test-key' }] };
    const adapter = createPromptAgentCanvasAdapter({ state });
    const plan = { steps: [{ id: 'generate', type: 'ImageGenerate', title: '生成', parameters: {} }], agentProviders: { gem: 'p' },
        agentThinking: { gem: { mode: 'level', value: 'high' } } };
    assert.deepEqual(adapter.modelsFor(plan, 'gem').generate.thinking, { mode: 'level', value: 'minimal' });
    plan.thinkingOverrides = { generate: { gem: { mode: 'level', value: 'high' } } };
    assert.deepEqual(adapter.modelsFor(plan, 'gem').generate.thinking, { mode: 'level', value: 'high' });
});

test('in-place image edits inherit the actual model, provider and thinking until explicitly overridden', () => {
    const configured = { id: 'configured', modelId: 'gemini-3.1-flash-image-preview', taskType: 'image', protocol: 'google', providerIds: ['existing-provider', 'panel-provider'],
        thinking: { profile: 'google-image', default: { mode: 'level', value: 'minimal' } } };
    const panel = { ...configured, id: 'panel', providerIds: ['panel-provider'] };
    const providers = ['existing-provider', 'panel-provider'].map(id => ({ id, endpoint: 'https://generativelanguage.googleapis.com', apikey: 'test-key' }));
    const node = { id: 'target', type: 'ImageGenerate', prompt: 'old', apiConfigId: configured.id,
        providerId: providers[0].id, thinking: { mode: 'level', value: 'high' } };
    const state = { models: [configured, panel], providers, connections: [], selectedNodes: new Set([node.id]) };
    const adapter = createPromptAgentCanvasAdapter({ state, serializeNodes: () => [node], getWorkflowId: () => 'workflow-a' });
    const plan = normalizeCanvasPlan({ version: 1, steps: [
        { id: 'edit', type: 'ImageGenerate', nodeId: node.id, parameters: { prompt: 'updated' }, execute: false }
    ] }, adapter.context());
    plan.applyInPlace = true;
    plan.agentProviders = { [configured.id]: providers[1].id, [panel.id]: providers[1].id };
    assert.deepEqual(adapter.modelsFor(plan, panel.id).edit, { model: configured, provider: providers[0], thinking: node.thinking });
    plan.modelOverrides.edit = panel.id;
    assert.deepEqual(adapter.modelsFor(plan, panel.id).edit, { model: panel, provider: providers[1], thinking: panel.thinking.default });
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
        providerId: 'provider', providers: [{ id: 'provider', endpoint: 'https://example.test/v1', apikey: 'secret' }],
        fetchRef: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payloads.shift()) } }] })); } });
    assert.equal(requests.length, 2); assert.equal(reply.canvasPlan.steps.length, 3);
    assert.ok(JSON.stringify(requests[1]).includes('canvasReads')); assert.ok(!JSON.stringify(requests).includes('secret'));
});

test('canvas vision reads only requested local originals and stops on missing media or cancellation', async () => {
    const model = { id: 'chat', modelId: 'test', protocol: 'openai', providerIds: ['p'], autoCompactTokenLimit: 100000 };
    const pixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const requests = [], assets = [];
    const run = (getCanvasImage, signal) => createPromptAgentModelReply({ model, canvasContext: graph(), signal, getCanvasImage,
        providerId: 'p', providers: [{ id: 'p', endpoint: 'https://example.test/v1', apikey: 'controlled-key' }],
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

test('canvas vision cannot read commerce output from different reference originals', async () => {
    const commerce = { id: 'commerce', type: 'ECommerceImageSet', mediaAssetKeys: ['media:previous-result'], imageCount: 1,
        commerceImageSet: { plan: { sourceKey: 'saved-plan', referenceRevision: 'v1:["media:old-reference"]' } } };
    const source = { id: 'reference', type: 'ImageImport', data: { imageImportAssetKey: 'media:new-reference' } };
    const connections = [{ id: 'ref', from: { nodeId: source.id, port: 'image' },
        to: { nodeId: commerce.id, port: 'referenceImages' } }];
    const context = graph({ nodes: [source, commerce], connections });
    assert.equal(context.read({ nodeIds: [commerce.id] }).nodes[0].assetCount, 0);
    const images = [];
    await assert.rejects(createPromptAgentModelReply({
        model: { id: 'chat', modelId: 'test', protocol: 'openai', providerIds: ['p'], autoCompactTokenLimit: 100000 },
        canvasContext: context, providerId: 'p',
        providers: [{ id: 'p', endpoint: 'https://example.test/v1', apikey: 'controlled-key' }],
        getCanvasImage: async key => { images.push(key); return null; },
        fetchRef: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ canvasRead:
            { nodeIds: [commerce.id], images: [{ nodeId: commerce.id, index: 0 }] } }) } }] })
    }), /画布图片不存在/);
    assert.deepEqual(images, []);
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
    assert.deepEqual(plan.disconnects, [{ ref: 'generation', port: 'referenceImages' }]);
});


test('Agent references use the actual visible multi-image port rather than invisible legacy sockets',()=>{
 const context=graph();
 const plan=promptPlanToCanvas({prompt:'poster',referenceImages:[{sourceNodeId:'source'}]},context);
 assert.equal(plan.connections[0].to.port,'referenceImages');
 assert.ok(context.nodes.find(n=>n.id==='target').inputs.some(p=>p.name===plan.connections[0].to.port));
 const raw=draft();raw.connections.push({from:{ref:'target',port:'image'},to:{ref:'hero',port:'image_2'}});
 const normalized=normalizeCanvasPlan(raw,context);
 assert.deepEqual(normalized.connections.filter(c=>c.to.ref==='hero').map(c=>[c.to.port,c.order]),[['referenceImages',0],['referenceImages',1]]);
});


test('prompt optimization retaining reference relationships does not silently disconnect inputs on generate intent', () => {
    const context = graph({ connections: [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, order: 0 }] });
    const raw = {version:1,steps:[{id:'generation',nodeId:'target',type:'ImageGenerate',parameters:{prompt:'优化后的产品图'}}],connections:[]};
    const options = {message:'请优化提示词，保留主体和现有参考关系。',mentionedIds:['target'],referencePolicy:{intent:'generate'}};
    assert.deepEqual(normalizeCanvasPlan(raw, context, options).disconnects, []);
    assert.deepEqual(normalizeCanvasPlan(raw, context, {...options,message:'优化提示词，但不要参考图'}).disconnects, [{ref:'generation',port:'referenceImages'}]);
});


test('legacy prompt-only revisions preserve connected references without relying on retention keywords',()=>{
    const context=graph({connections:[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}]});
    const plan=promptPlanToCanvas({targetNodeId:'target',prompt:'新的背景',referenceImages:[]},context);
    const projected=projectPlanConnections(plan,context.connections,ref=>ref==='generate'?'target':ref);
    assert.equal(projected.length,1,'legacy prompt plans must retain an existing reference when the model omits imageRoles');
    assert.equal(projected[0].from.nodeId,'source');
});

test('generate intent alone cannot remove references and model disconnects require a user request',()=>{
    const context=graph({connections:[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}]});
    const raw={version:1,steps:[{id:'g',nodeId:'target',type:'ImageGenerate',parameters:{prompt:'蓝色背景'}}],connections:[]};
    const options={message:'@图片生成[target] 背景改成蓝色',mentionedIds:['target'],referencePolicy:{intent:'generate'}};
    assert.deepEqual(normalizeCanvasPlan(raw,context,options).disconnects,[]);
    assert.throws(()=>normalizeCanvasPlan({...raw,disconnects:[{ref:'g',port:'referenceImages'}]},context,options),/参考图/);
});


test('reference protection handles negative instructions, partial replacement and explicit removal',()=>{
    const context=graph({connections:[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0},{from:{nodeId:'second',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:1}],
        nodes:[...graph().nodes,{id:'second',type:'ImageImport',mediaAssetKeys:['media:second']}]});
    const raw={version:1,steps:[{id:'g',nodeId:'target',type:'ImageGenerate',parameters:{prompt:'蓝色背景'}}],connections:[]};
    for(const message of ['不要断开参考图','参考图不要删除','保留参考图并把背景换成蓝色','不要改成纯文字生图，保留参考图','不要不使用参考图','删除参考图1，保留参考图2']) {
        const plan=normalizeCanvasPlan(raw,context,{message,mentionedIds:['target'],referencePolicy:{intent:'generate',selection:{mode:'none'}}});
        assert.equal(plan.referenceInputChange,null,message);assert.deepEqual(plan.disconnects,[]);
        assert.throws(()=>normalizeCanvasPlan({...raw,disconnects:[{ref:'g',port:'referenceImages'}]},context,{message,mentionedIds:['target']}),/参考图/);
    }
    const partial={...raw,connections:[{from:{ref:'source',port:'image'},to:{ref:'g',port:'referenceImages'}}]};
    assert.throws(()=>normalizeCanvasPlan(partial,context,{message:'优化提示词',mentionedIds:['target']}),/参考图/);
    const reversed={...raw,connections:[{from:{ref:'second',port:'image'},to:{ref:'g',port:'referenceImages'},order:0},{from:{ref:'source',port:'image'},to:{ref:'g',port:'referenceImages'},order:1}]};
    assert.throws(()=>normalizeCanvasPlan(reversed,context,{message:'只改提示词，参考图保持原样',mentionedIds:['target'],referencePolicy:{intent:'edit'}}),/顺序/);

    const cleared=normalizeCanvasPlan(raw,context,{message:'不要参考图，纯文字生成',mentionedIds:['target']});
    assert.equal(cleared.referenceInputChange.mode,'clear');
    for(const message of ['@图片生成[target] 不要参考图，纯文字生成','不要参考图了','@图片生成[target] 断开参考图','清空参考图','删除全部参考图']) {
        const explicit=normalizeCanvasPlan(raw,context,{message,mentionedIds:['target']});
        assert.equal(explicit.referenceInputChange.mode,'clear',message);
        assert.deepEqual(projectPlanConnections(explicit,context.connections,ref=>ref==='g'?'target':ref),[]);
    }

    assert.deepEqual(projectPlanConnections(cleared,context.connections,ref=>ref==='g'?'target':ref),[]);
    const replaced=normalizeCanvasPlan(partial,context,{message:'替换参考图，仅使用产品图',mentionedIds:['target']});
    assert.equal(projectPlanConnections(replaced,context.connections,ref=>ref==='g'?'target':ref).length,1);
});


test('application guard blocks a historical destructive plan before any graph mutation',async()=>{
    const nodes=[{id:'source',type:'ImageImport',mediaAssetKeys:['media:source']},{id:'target',type:'ImageGenerate',apiConfigId:'manual',providerId:'p',prompt:'old'}];
    const connections=[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}];
    const state={nodes:new Map(nodes.map(node=>[node.id,node])),connections,models:[{id:'manual',modelId:'gpt-image',protocol:'openai',taskType:'image',providerIds:['p']}],providers:[{id:'p',endpoint:'https://controlled.test/v1',apikey:'test'}],runningNodeIds:new Set(),selectedNodes:new Set()};
    const context=createCanvasContext({workflowId:'workflow-a',nodes,connections});
    const plan=normalizeCanvasPlan({version:1,steps:[{id:'g',nodeId:'target',type:'ImageGenerate',parameters:{prompt:'new'}}]},context,{mentionedIds:['target'],message:'优化提示词'});
    delete plan.referenceInputChange;plan.agentProviders={manual:'p'};plan.disconnects=[{ref:'g',port:'referenceImages'}];
    let mutated=false;
    const adapter=createPromptAgentCanvasAdapter({state,documentRef:{getElementById:()=>null},serializeNodes:()=>nodes,getWorkflowId:()=> 'workflow-a',nodeAdapter:{getContext:()=>({parameters:{}})},session:()=>({applyCanvasBatch:()=>{mutated=true;}})});
    await assert.rejects(adapter.apply(plan,'manual'),/参考图/);
    assert.equal(mutated,false);assert.equal(state.connections.length,1);
});


test('prompt-only snapshot cannot be silently rebound to changed current source assets',()=>{
    const context=graph({connections:[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}]});
    assert.throws(()=>promptPlanToCanvas({targetNodeId:'target',prompt:'new',preserveReferenceSnapshot:true,referenceImages:[{sourceNodeId:'source',sourcePort:'image',sourceImageIndex:0,assetKey:'media:old'}]},context),/参考图|原图/);
});


test('deleted plan-created nodes can be rebuilt without accepting other dependency changes', () => {
    const nodes = [
        { id: 'source', type: 'ImageImport', mediaAssetKeys: ['media:one'] },
        { id: 'second', type: 'ImageImport', mediaAssetKeys: ['media:two'] },
        { id: 'made', type: 'ImageGenerate', prompt: 'poster' },
        { id: 'saved', type: 'ImageSave' }
    ];
    const connections = [
        { id: 'first', order: 5, from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'made', port: 'referenceImages' } },
        { id: 'second', order: 9, from: { nodeId: 'second', port: 'image' }, to: { nodeId: 'made', port: 'referenceImages' } },
        { id: 'save', from: { nodeId: 'made', port: 'image' }, to: { nodeId: 'saved', port: 'image' } }
    ];
    const context = graph({ nodes, connections });
    const plan = { workflowId: 'workflow-a', steps: [{ id: 'generate', type: 'ImageGenerate' }, { id: 'save', type: 'ImageSave' }],
        bindings: { generate: 'made', save: 'saved' }, dependencies: nodes.map(node => node.id) };
    plan.baseline = canvasBaseline(context, plan.dependencies, ['made', 'saved']);
    const afterDelete = graph({ nodes: nodes.filter(node => node.id !== 'made'), connections: [] });
    const recovery = prepareCanvasPlanRecreation(plan, afterDelete);
    assert.deepEqual([...recovery.missingIds], ['made']);
    assert.deepEqual(recovery.affectedSteps, ['generate', 'save']);
    assert.deepEqual(recovery.connections.map(edge => [edge.id, edge.order]), [['first', 5], ['second', 9], ['save', undefined]]);
    assert.throws(() => prepareCanvasPlanRecreation(plan, { ...afterDelete, workflowId: 'other' }), /变化/);
    assert.throws(() => prepareCanvasPlanRecreation(plan, graph({ nodes: nodes.filter(node => !['source', 'made'].includes(node.id)), connections: [] })), /变化/);
    assert.throws(() => prepareCanvasPlanRecreation(plan, graph({ nodes: nodes.filter(node => node.id !== 'made').map(node => node.id === 'second' ? { ...node, mediaAssetKeys: ['media:changed'] } : node), connections: [] })), /变化/);
    assert.throws(() => prepareCanvasPlanRecreation({ ...plan, steps: [{ id: 'generate', type: 'ImageGenerate', nodeId: 'made' }, plan.steps[1]] }, afterDelete), /变化/);
    const saveDeleted = graph({ nodes: nodes.filter(node => node.id !== 'saved'), connections: connections.slice(0, 2) });
    assert.deepEqual(prepareCanvasPlanRecreation(plan, saveDeleted).affectedSteps, ['save']);
    saveDeleted.connections.reverse();
    assert.throws(() => prepareCanvasPlanRecreation(plan, saveDeleted), /变化/);
});


test('recreation retains unrelated connection edits made during original asset loading', async () => {
    const state = { nodes: new Map([
        ['external-text', { id: 'external-text', type: 'Text' }],
        ['external-image', { id: 'external-image', type: 'ImageGenerate' }]
    ]), connections: [], selectedNodes: new Set(), models: [], providers: [] };
    let serial = 0, editDuringLoad = false;
    const edge = { id: 'unrelated-new', type: 'text', order: 12, from: { nodeId: 'external-text', port: 'text' }, to: { nodeId: 'external-image', port: 'prompt' } };
    const adapter = createPromptAgentCanvasAdapter({ state, documentRef: { body: { children: [] } },
        serializeNodes: () => [...state.nodes.values()], getWorkflowId: () => 'workflow-a',
        addNode(type, x, y, data) { const id = `import-${++serial}`; state.nodes.set(id, { ...data, id, type, x, y }); return id; },
        getImageAsset: async () => { if (editDuringLoad) state.connections = [edge]; return 'original'; },
        session: () => ({ applyCanvasBatch: async (mutate, persist) => { await mutate(); await persist(); return { historyId: 'applied' }; } }),
        save: async () => true, graphChanged() {}, origin: () => ({ x: 0, y: 0 }), focusNode() {}
    });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'input', type: 'ImageImport', imageId: 'original' }] }, adapter.context(),
        { images: [{ imageId: 'original', reference: { assetKey: 'media:original' } }] });
    await adapter.apply(plan, '');
    state.nodes.delete(plan.bindings.input);
    state.connections = [{ ...edge, id: 'unrelated-old' }];
    editDuringLoad = true;
    await adapter.apply(plan, '');
    assert.deepEqual(state.connections, [edge], 'the removed edge stays removed and the new edge survives');
    assert.ok(state.nodes.has(plan.bindings.input));
});

test('Agent can propose 100 empty image import nodes without importing assets or executing', () => {
    const context = graph({ nodes: [] });
    const raw = { version: 1, steps: Array.from({ length: 100 }, (_, i) => ({
        id: `empty${i}`, type: 'ImageImport', title: `图片 ${i + 1}`, execute: false
    })), connections: [] };
    const plan = normalizeCanvasPlan(raw, context, { message: '只创建节点 不导入图',
        referencePolicy: { intent: 'generate', selection: { mode: 'none' } } });
    assert.equal(plan.steps.length, 100);
    assert.ok(plan.steps.every(step => step.execute === false && !step.assetKey));
    assert.throws(() => normalizeCanvasPlan({ ...raw, steps: [...raw.steps, { id: 'extra', type: 'Text' }] }, context), /100/);
});

test('empty image imports cannot execute or supply nonexistent reference images', () => {
    const context = graph({ nodes: [] });
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [{ id: 'empty', type: 'ImageImport' }] }, context), /原图资产/);
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [
        { id: 'empty', type: 'ImageImport', execute: false },
        { id: 'generate', type: 'ImageGenerate', parameters: { prompt: 'test' } }
    ], connections: [{ from: { ref: 'empty', port: 'image' }, to: { ref: 'generate', port: 'referenceImages' } }] }, context), /空图片节点/);
});

test('independent Agent batches use measured grid cells and avoid occupied content as one block at every zoom', () => {
    const viewport = { x: 100, y: 200, width: 1000, height: 800 };
    for (const zoom of [0.12, 0.5, 1, 2]) {
        const nodes = Array.from({ length: 7 }, (_, i) => ({ id: `new-${i}`, width: 999, height: 999,
            el: { style: {}, offsetWidth: i === 1 ? 320 : 260, offsetHeight: i === 2 ? 420 : 280 } }));
        layoutIndependentCanvasNodes(nodes, { viewport, zoom });
        assert.deepEqual([nodes[0].x, nodes[0].y], [470, 460], 'the first card is centered when the grid is larger than the viewport');
        const occupied = [{ x: 100, y: 200, width: 500, height: 600 }];
        const before = structuredClone(occupied);
        layoutIndependentCanvasNodes(nodes, { viewport, occupied, zoom });
        assert.deepEqual(occupied, before);
        assert.equal(new Set(nodes.map(node => node.x)).size, 3);
        assert.equal(new Set(nodes.map(node => node.y)).size, 3);
        for (const [index, node] of nodes.entries()) {
            assert.equal(node.x, nodes[0].x + index % 3 * 360);
            assert.equal(node.y, nodes[0].y + Math.floor(index / 3) * 460);
            assert.equal(node.el.style.left, `${node.x}px`);
            assert.equal(node.el.style.top, `${node.y}px`);
            assert.ok(node.x >= 640 || node.y >= 840 || node.x + 320 + 40 <= 100 || node.y + 420 + 40 <= 200);
        }
        const block = { x: nodes[0].x, y: nodes[0].y, width: 1040, height: 1340 };
        const second = nodes.map(node => ({ id: node.id, width: 320, height: 420 }));
        layoutIndependentCanvasNodes(second, { viewport, occupied: [...occupied, block], zoom });
        assert.ok(second[0].x >= block.x + block.width + 40 || second[0].y >= block.y + block.height + 40
            || second[0].x + block.width + 40 <= block.x || second[0].y + block.height + 40 <= block.y);
    }
});
