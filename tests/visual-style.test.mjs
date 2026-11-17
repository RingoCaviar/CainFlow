import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualStylePrompt, normalizeVisualStyle, resolveVisualStyle, visualStyleKey } from '../js/features/visual-style/visual-style.js';
import { resolveUniversalInput } from '../js/nodes/universal-input-policy.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { analyzeVisualStyle } from '../js/features/visual-style/visual-style-analysis.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import '../js/features/execution/protocols/google.js';

test('风格配置可共用，明确保护主体且排版仅在有文字时启用', () => {
    const style = normalizeVisualStyle({ preset: 'natural', typography: '标题左对齐', palette: '苔藓绿' });
    const prompt = buildVisualStylePrompt(style);
    assert.match(prompt, /苔藓绿/);
    assert.match(prompt, /商品.*颜色/);
    assert.doesNotMatch(prompt, /标题左对齐/);
    assert.match(buildVisualStylePrompt(style, { lettering: true }), /标题左对齐/);
    const node = { id: 's', type: 'VisualStyle', data: { visualStyle: style } };
    const state = { nodes: new Map([['s', node]]), connections: ['a', 'b'].map(id => ({ from: { nodeId: 's', port: 'style' }, to: { nodeId: id, port: 'style' } })) };
    const snapshot = resolveVisualStyle(state, 'a');
    assert.deepEqual(snapshot, resolveVisualStyle(state, 'b'));
    node.data.visualStyle.palette = '深蓝';
    assert.equal(snapshot.palette, '苔藓绿');
    assert.notEqual(visualStyleKey(snapshot), visualStyleKey(resolveVisualStyle(state, 'a')));
});

test('风格端口限制一个来源且 Agent/MCP 公开可校验字段', () => {
    const source = { id: 's', type: 'VisualStyle', visualStyle: { preset: 'natural', palette: '青色' } };
    const target = { id: 'c', type: 'ECommerceImageSet' };
    const state = { nodes: new Map([['s', source], ['c', target]]), connections: [] };
    const input = { state, sourceNode: source, sourcePort: 'style', targetNode: target };
    assert.deepEqual(resolveUniversalInput(input), { port: 'style', type: 'style', multiple: false, error: '' });
    state.connections.push({ from: { nodeId: 'other', port: 'style' }, to: { nodeId: 'c', port: 'style' } });
    assert.match(resolveUniversalInput(input).error, /占用/);
    const context = createCanvasContext({ workflowId: 'w', nodes: [source, target], connections: [], selectedIds: ['c'] });
    assert.equal(context.read({}).nodes.find(node => node.id === 's').parameters.palette, '青色');
    const draft = { version: 1, steps: [{ id: 'style', type: 'VisualStyle', parameters: { preset: 'natural', palette: '金色' }, execute: false },
        { id: 'commerce', type: 'ECommerceImageSet', nodeId: 'c', parameters: {}, execute: false }],
        connections: [{ from: { ref: 'style', port: 'style' }, to: { ref: 'commerce', port: 'style' } }] };
    assert.equal(normalizeCanvasPlan(draft, context).connections[0].type, 'style');
    assert.throws(() => normalizeCanvasPlan({ ...draft, steps: [{ ...draft.steps[0], parameters: { preset: 'invalid' } }] }, context), /不受支持/);
});

test('参考图提取仅替换选中维度，不泄露图片内容到主体描述', async () => {
    let request;
    const result = await analyzeVisualStyle({ node: { data: { styleModelId: 'v', styleProviderId: 'p', visualStyle: { description: '保留描述', lighting: '自然光' } } },
        references: ['data:image/png;base64,AAAA'], fields: ['palette'],
        models: [{ id: 'v', modelId: 'gemini', taskType: 'chat', protocol: 'google', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test', apikey: 'fixture' }], getProxyHeaders: () => ({}),
        fetchRef: async (_url, options) => { request = JSON.parse(options.body); return Response.json({ candidates: [{ content: { parts: [{ text: '{"palette":"暖棕色","lighting":"强闪光"}' }] } }] }); } });
    assert.equal(result.palette, '暖棕色');
    assert.equal(result.lighting, '自然光');
    assert.equal(result.description, '保留描述');
    assert.match(JSON.stringify(request), /不复制商品/);
});

test('画布方案实际创建风格并应用预设与字段，保存一次', async () => {
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: { zoom: 1 }, models: [], providers: [] };
    let saved = 0;
    const adapter = createPromptAgentCanvasAdapter({ state,
        documentRef: { body: { children: [] }, getElementById: () => null },
        serializeNodes: () => [...state.nodes.values()], getWorkflowId: () => 'w',
        addNode(type, x, y, data) { state.nodes.set('created', { id: 'created', type, x, y, data, width: 340, height: 480 }); return 'created'; },
        session: () => ({ applyCanvasBatch: async (mutate, persist) => { const result = await mutate(); await persist(); return result; } }),
        save: async () => { saved++; return true; }, graphChanged() {}, origin: () => ({ x: 0, y: 0 }) });
    const plan = normalizeCanvasPlan({ version: 1, steps: [{ id: 'style', type: 'VisualStyle', execute: false, parameters: { preset: 'natural', description: '自然氛围' } }] },
        createCanvasContext({ workflowId: 'w', nodes: [], connections: [] }));
    await adapter.apply(plan, '');
    assert.equal(state.nodes.get('created').data.visualStyle.lighting, '柔和自然光');
    assert.equal(state.nodes.get('created').data.visualStyle.description, '自然氛围');
    assert.equal(saved, 1);
});
