import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan, assertCanvasPlanCurrent, promptPlanToCanvas, describeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';
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
    assert.throws(() => assertCanvasPlanCurrent(plan, context), /下方 Agent 输入框发送“根据当前画布重新生成方案”/);
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
