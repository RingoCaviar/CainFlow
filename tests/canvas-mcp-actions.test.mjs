import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasMcpActions } from '../js/features/canvas-mcp/canvas-mcp-actions.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';

test('MCP reads and validates visual style edits with revision guards', async () => {
    const node = { id: 'style', type: 'VisualStyle', visualStyle: { preset: 'natural', palette: '青绿' } };
    let applied = 0;
    const { dispatch } = createCanvasMcpActions({ canvasAdapter: {
        context: () => createCanvasContext({ workflowId: 'style-workflow', nodes: [node], connections: [] }),
        async apply(plan) {
            applied++;
            Object.assign(node.visualStyle, plan.steps[0].parameters);
            plan.bindings[plan.steps[0].id] = node.id;
            return plan;
        }
    } });
    const read = await dispatch('read_canvas');
    assert.equal(read.nodes[0].parameters.palette, '青绿');
    const plan = { version: 1, steps: [{ id: 'edit', nodeId: node.id, type: node.type, execute: false, parameters: { palette: '暖棕色' } }] };
    const write = { workflowId: read.workflowId, revision: read.revision, plan };
    await dispatch('edit_canvas', write);
    assert.equal((await dispatch('read_canvas')).nodes[0].parameters.palette, '暖棕色');
    await assert.rejects(dispatch('edit_canvas', write), { code: 'stale_revision' });
    const current = await dispatch('read_canvas');
    plan.steps[0].parameters = { palette: 9 };
    await assert.rejects(dispatch('edit_canvas', { ...write, revision: current.revision }), /类型无效/);
    assert.equal(applied, 1);
});

test('reads a page of the live workflow with a stable revision and projected node fields', async () => {
    const nodes = [
        { id: 'intro', type: 'Text', text: 'First', apikey: 'private' },
        { id: 'next', type: 'Text', text: 'Second' }
    ];
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId: 'wf-a', nodes, connections: [], selectedIds: ['intro'] }) }
    });
    const canvas = await dispatch('read_canvas', {});
    const page = await dispatch('read_canvas', { workflowId: 'wf-a', offset: 1 });
    assert.equal(canvas.workflowId, 'wf-a');
    assert.ok(canvas.revision);
    assert.equal(page.revision, canvas.revision);
    assert.equal(canvas.totalNodes, 2);
    assert.deepEqual(canvas.selectedIds, ['intro']);
    assert.ok(canvas.editableTypes.includes('Text'));
    assert.deepEqual(page.nodes.map(node => node.parameters.text), ['Second']);
    assert.equal(JSON.stringify(canvas).includes('private'), false);
    const scope = { workflowId: canvas.workflowId, revision: canvas.revision, offset: 1 };
    assert.deepEqual(await dispatch('read_canvas', scope), page);
    await assert.rejects(dispatch('read_canvas', scope, { isCurrent: () => false }), { code: 'stale_editor' });
    nodes[0].text = 'Changed between pages';
    await assert.rejects(dispatch('read_canvas', scope), { code: 'stale_revision' });
    assert.notEqual((await dispatch('read_canvas', { offset: 1 })).revision, canvas.revision);
});

test('edits the live graph in place and rejects stale and wrong-workflow writes', async () => {
    const nodes = [{ id: 'intro', type: 'Text', text: 'First' }];
    let workflowId = 'wf-a';
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: {
            context: () => createCanvasContext({ workflowId, nodes, connections: [] }),
            async apply(plan) {
                const step = plan.steps[0];
                nodes.find(node => node.id === step.nodeId).text = step.parameters.text;
                plan.bindings[step.id] = step.nodeId;
                return plan;
            }
        }
    });
    const plan = { version: 1, steps: [{ id: 'edit', nodeId: 'intro', type: 'Text', parameters: { text: 'Revised' } }] };
    const { revision } = await dispatch('read_canvas');
    const edited = await dispatch('edit_canvas', { workflowId, revision, plan });
    assert.deepEqual(edited.bindings, { edit: 'intro' });
    assert.notEqual(edited.revision, revision);
    assert.equal((await dispatch('read_canvas')).nodes[0].parameters.text, 'Revised');
    await assert.rejects(dispatch('edit_canvas', { workflowId, revision, plan }), { code: 'stale_revision' });
    workflowId = 'wf-b';
    await assert.rejects(dispatch('edit_canvas', { workflowId: 'wf-a', revision: edited.revision, plan }), { code: 'wrong_workflow' });
});

test('MCP uses the normal workflow run for commerce and projects only selected results', async () => {
    const workflowId = 'commerce-workflow';
    const node = { id: 'commerce', type: 'ECommerceImageSet', mediaAssetKeys: ['media:current'],
        commerceImageSet: { platformId: 'amazon', selectedShotIds: ['feature'], candidateCount: 3,
            plan: { version: 1, platformId: 'amazon', sourceKey: 'references', confirmed: true,
                sellingPoints: [], shots: [{ id: 'feature', prompt: '当前方案' }] },
            results: [{ shotId: 'feature', status: 'completed', assetKey: 'media:current' }],
            candidates: [{ shotId: 'feature', assetKey: 'media:older', aspect: '1:1', draft: { prompt: '候选草稿' } }] } };
    let startCount = 0;
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes: [node], connections: [] }) },
        async runWorkflow(input, options) {
            options.validateBeforeRun();
            startCount++;
            assert.equal(input.mode, 'selected-only');
            assert.deepEqual(input.selectedNodeIds, [node.id]);
            assert.equal(input.commerceAction, undefined);
            assert.equal(input.candidateCount, undefined);
            return { workflowId, outcome: 'completed', started: true, executed: true,
                nodeResults: [{ nodeId: node.id, succeeded: true, imageCount: 1, mediaAssetKeys: node.mediaAssetKeys }] };
        }
    });
    const canvas = await dispatch('read_canvas');
    assert.ok(canvas.nodes.find(item => item.id === node.id).inputs.some(port => port.name === 'styleReferenceImages' && port.type === 'image'));
    assert.doesNotMatch(JSON.stringify(canvas), /media:older|候选草稿|finalized|candidateCount|commerceRunSettings/);
    node.commerceImageSet.shotReferences = { '*': ['media:style'] };
    await assert.rejects(dispatch('run_workflow', { workflowId, revision: canvas.revision, nodeIds: [node.id] }), { code: 'stale_revision' });
    assert.doesNotMatch(JSON.stringify((await dispatch('read_canvas')).nodes), /media:style/);
    delete node.commerceImageSet.shotReferences;
    const restored = await dispatch('read_canvas');
    await assert.rejects(dispatch('edit_canvas', { workflowId, revision: restored.revision, plan: { version: 1, steps: [
        { id: 'edit', type: node.type, nodeId: node.id, parameters: { candidateCount: 8 }, execute: false }
    ] } }), /不支持参数.*candidateCount/);
    node.commerceImageSet.candidateCount = 8;
    await assert.rejects(dispatch('run_workflow', { workflowId, revision: restored.revision, nodeIds: [node.id] }), { code: 'stale_revision' });
    const updated = await dispatch('read_canvas');
    node.commerceImageSet.results[0].finalized = true;
    await assert.rejects(dispatch('run_workflow', { workflowId, revision: updated.revision, nodeIds: [node.id] }), { code: 'stale_revision' });
    const locked = await dispatch('read_canvas');
    delete node.commerceImageSet.results[0].finalized;
    await assert.rejects(dispatch('run_workflow', { workflowId, revision: locked.revision, nodeIds: [node.id] }), { code: 'stale_revision' });
    const unlocked = await dispatch('read_canvas');
    assert.deepEqual([updated.nodes, locked.nodes, unlocked.nodes], [canvas.nodes, canvas.nodes, canvas.nodes]);
    assert.equal(startCount, 0);
    const run = await dispatch('run_workflow', { workflowId, revision: unlocked.revision, nodeIds: [node.id] });
    await new Promise(resolve => setImmediate(resolve));
    const result = await dispatch('get_workflow_run', run);
    assert.equal(result.status, 'completed');
    assert.equal(startCount, 1);
    assert.deepEqual(result.nodeResults[0].mediaAssetKeys, ['media:current']);
});

test('MCP omits stale or unverified commerce output from canvas reads and batch selection', async () => {
    const workflowId = 'commerce-references';
    const source = { id: 'source', type: 'ImageImport', mediaAssetKeys: ['media:original'] };
    const commerce = { id: 'commerce', type: 'ECommerceImageSet', mediaAssetKeys: ['media:result'], imageCount: 1,
        commerceImageSet: { plan: { sourceKey: 'saved-plan', referenceRevision: 'v1:["media:original"]' } } };
    const edge = { id: 'ref', from: { nodeId: source.id, port: 'image' }, to: { nodeId: commerce.id, port: 'referenceImages' } };
    const { dispatch } = createCanvasMcpActions({ canvasAdapter: { context: () => createCanvasContext({
        workflowId, nodes: [source, commerce], connections: [edge], selectedIds: [commerce.id] }) } });

    const initial = await dispatch('read_canvas');
    assert.deepEqual(initial.nodes[1].assets, ['media:result']);
    assert.equal(initial.nodes[1].imageCount, 1);
    source.mediaAssetKeys = ['media:replacement'];
    const stale = await dispatch('read_canvas');
    assert.deepEqual(stale.nodes[1].assets, []);
    assert.equal(stale.nodes[1].assetCount, 0);
    assert.equal(stale.nodes[1].imageCount, undefined);
    await assert.rejects(dispatch('generate_image_batch', { workflowId, revision: stale.revision, prompt: '批处理' }), /没有可用原图/);

    delete commerce.commerceImageSet.plan.referenceRevision;
    const legacy = await dispatch('read_canvas');
    assert.deepEqual(legacy.nodes[1].assets, []);
    assert.equal(legacy.nodes[1].imageCount, undefined);
    source.enabled = false;
    assert.deepEqual((await dispatch('read_canvas')).nodes[1].assets, []);
    source.enabled = true;

    commerce.commerceImageSet.plan = null;
    commerce.commerceImageSet.previousExportResults = [{ outputKey: 'media:result', referenceRevision: 'v1:["media:original"]' }];
    const archived = await dispatch('read_canvas');
    assert.deepEqual(archived.nodes[1].assets, []);
    source.mediaAssetKeys = ['media:original'];
    assert.deepEqual((await dispatch('read_canvas')).nodes[1].assets, ['media:result']);
});

test('MCP applies ordinary scalar edits through the native controls and preserves node identity', async () => {
    const workflowId = 'scalar-edit';
    const edits = [
        ['chat', 'TextChat', [
            ['prompt', 'prompt', 'new question'], ['sysprompt', 'sysprompt', 'private instruction'],
            ['fixed', 'fixed', true, 'checkbox']
        ]],
        ['video', 'VideoGenerate', [
            ['prompt', 'prompt', 'new scene'], ['aspect', 'aspect', '9:16', 'select'],
            ['generationCount', 'generation-count', 3, 'number']
        ]],
        ['color', 'ColorReset', [
            ['whiteBalanceMode', 'white-balance', 'auto', 'select'], ['temperature', 'temperature', -30, 'range']
        ]],
        ['split', 'TextSplit', [
            ['previewEnabled', 'preview-enabled', false, 'checkbox']
        ]]
    ];
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), models: [], providers: [] };
    const controls = new Map();
    const changes = [];
    for (const [id, type, fields] of edits) {
        const node = { id, type };
        state.nodes.set(id, node);
        for (const [field, suffix, value, inputType] of fields) {
            const options = field === 'aspect' ? ['16:9', '9:16'] : ['original', 'auto'];
            const control = {
                type: inputType,
                ...(inputType === 'select' ? { options: options.map(value => ({ value })) } : {}),
                ...(inputType === 'number' ? { min: '1' } : {}),
                dispatchEvent(event) {
                    if (event.type !== 'change') return;
                    node[field] = typeof value === 'boolean' ? this.checked : typeof value === 'number' ? Number(this.value) : this.value;
                    changes.push([id, field]);
                }
            };
            controls.set(`${id}-${suffix}`, control);
        }
    }
    const documentRef = { body: { children: [] }, defaultView: { Event }, getElementById: id => controls.get(id) };
    let saves = 0;
    const canvasAdapter = createPromptAgentCanvasAdapter({ state, documentRef, getWorkflowId: () => workflowId,
        serializeNodes: () => [...state.nodes.values()], origin: () => ({ x: 0, y: 0 }), graphChanged: () => {},
        session: () => ({ applyCanvasBatch: async (mutate, persist) => { await mutate(); await persist(); return { historyId: 'edit' }; } }),
        save: async () => { saves++; return true; }
    });
    const { dispatch } = createCanvasMcpActions({ canvasAdapter });
    const { revision } = await dispatch('read_canvas');
    const steps = edits.map(([id, type, fields]) => ({ id: `edit-${id}`, type, nodeId: id,
        parameters: Object.fromEntries(fields.map(([field, , value]) => [field, value])) }));
    await dispatch('edit_canvas', { workflowId, revision, plan: { version: 1, steps } });
    const edited = await dispatch('read_canvas');
    assert.deepEqual(edited.nodes.map(node => [node.id, node.parameters]), steps.map(step => [step.nodeId, step.parameters]));
    assert.deepEqual(changes, edits.flatMap(([id, , fields]) => fields.map(([field]) => [id, field])));
    assert.equal(saves, 1);
});

test('uses only listed model and provider identities for typed generation edits', async () => {
    const workflowId = 'wf-a';
    const models = [{ id: 'other-model', modelId: 'gemini-image', name: 'Image model', apikey: 'hidden',
        providers: [{ id: 'other-provider', name: 'Alternate', endpoint: 'https://private.test/v1' }, { id: 'second-provider', name: 'Second' }] }];
    let applied;
    const { dispatch } = createCanvasMcpActions({
        getImageModels: () => models,
        canvasAdapter: {
            context: () => createCanvasContext({ workflowId, nodes: [], connections: [] }),
            async apply(plan) { applied = plan; return plan; }
        }
    });
    assert.deepEqual(await dispatch('list_models'), { models: [{
        id: 'other-model', modelId: 'gemini-image', name: 'Image model',
        providers: [{ id: 'other-provider', name: 'Alternate' }, { id: 'second-provider', name: 'Second' }]
    }] });
    const { revision } = await dispatch('read_canvas');
    const edit = (choices) => dispatch('edit_canvas', { workflowId, revision, plan: { version: 1, steps: [{
        id: 'generate', type: 'ImageGenerate', parameters: { prompt: 'Retouch' }, ...choices
    }] } });
    await assert.rejects(edit({ modelId: 'other-model' }), { code: 'invalid_arguments' });
    await assert.rejects(edit({ modelId: 'other-model', providerId: 'unbound' }), { code: 'invalid_arguments' });
    await assert.rejects(edit({ modelId: 'custom-url', providerId: 'other-provider' }), { code: 'invalid_arguments' });
    assert.equal(applied, undefined);
    await edit({ modelId: 'other-model', providerId: 'other-provider' });
    assert.deepEqual(applied.modelOverrides, { generate: 'other-model' });
    assert.deepEqual(applied.providerOverrides, { generate: { 'other-model': 'other-provider' } });
});

test('applies a selected image batch once and starts only its newly bound generation and preview nodes', async () => {
    const workflowId = 'wf-a';
    const nodes = Array.from({ length: 12 }, (_, index) => ({
        id: `source-${index}`, type: 'ImageImport', mediaAssetKeys: [`media:source-${index}`]
    }));
    let selectedIds = nodes.map(node => node.id);
    let applied;
    let runInput;
    const { dispatch } = createCanvasMcpActions({
        getImageDefaults: () => ({ modelId: 'model', providerIds: { model: 'provider' } }),
        canvasAdapter: {
            context: () => createCanvasContext({ workflowId, nodes, connections: [], selectedIds }),
            async apply(plan, modelId, _onPlanChange, isCurrent) {
                assert.equal(applied, undefined);
                assert.equal(modelId, 'model');
                assert.ok(isCurrent());
                applied = plan;
                for (const step of plan.steps) {
                    const id = `new-${step.id}`;
                    plan.bindings[step.id] = id;
                    nodes.push({ id, type: step.type });
                }
                return plan;
            }
        },
        async runWorkflow(input, options) {
            options.validateBeforeRun();
            runInput = input;
            return { workflowId, outcome: 'completed' };
        }
    });
    const prompt = '统一成自然棚拍风格';
    const original = await dispatch('read_canvas');
    selectedIds = selectedIds.slice(1);
    await assert.rejects(dispatch('generate_image_batch', { workflowId, revision: original.revision, prompt, run: true }),
        { code: 'stale_revision' });
    assert.equal(applied, undefined);
    selectedIds = original.selectedIds;
    const canvas = await dispatch('read_canvas');
    const batch = await dispatch('generate_image_batch', { workflowId, revision: canvas.revision, prompt, run: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(applied.steps.filter(step => step.type === 'Text').length, 1);
    assert.equal(applied.steps.filter(step => step.type === 'ImageGenerate').length, 12);
    assert.equal(applied.steps.filter(step => step.type === 'ImagePreview').length, 12);
    assert.deepEqual(applied.connections.filter(edge => edge.to.port === 'referenceImages').map(edge => edge.from.ref), original.selectedIds);
    assert.notEqual(batch.revision, canvas.revision);
    assert.equal(batch.nodeIds.length, 24);
    assert.deepEqual(runInput, { mode: 'selected-only', selectedNodeIds: batch.nodeIds, imageBatch: true });
    assert.equal((await dispatch('get_workflow_run', batch.run)).status, 'completed');
});

test('an explicit typed connection can replace an existing prompt input', async () => {
    const nodes = [
        { id: 'old-text', type: 'Text', text: 'Original prompt' },
        { id: 'new-text', type: 'Text', text: 'New prompt' },
        { id: 'image', type: 'ImageGenerate', apiConfigId: 'model', providerId: 'provider' }
    ];
    let connections = [{ id: 'original', from: { nodeId: 'old-text', port: 'text' }, to: { nodeId: 'image', port: 'prompt' } }];
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: {
            context: () => createCanvasContext({ workflowId: 'wf-a', nodes, connections }),
            async apply(plan) {
                plan.bindings.target = 'image';
                connections = projectPlanConnections(plan, connections, ref => plan.bindings[ref] || ref);
                return plan;
            }
        }
    });
    const { revision, workflowId } = await dispatch('read_canvas');
    await dispatch('edit_canvas', { workflowId, revision, plan: {
        version: 1,
        steps: [{ id: 'target', type: 'ImageGenerate', nodeId: 'image' }],
        connections: [{ from: { ref: 'new-text', port: 'text' }, to: { ref: 'target', port: 'prompt' } }]
    } });
    const canvas = await dispatch('read_canvas');
    assert.deepEqual(canvas.connections.map(({ from, to }) => [from.nodeId, to.nodeId, to.port]), [['new-text', 'image', 'prompt']]);
});

test('runs a selected live node and reports its own results after switching workflows', async () => {
    let workflowId = 'wf-a';
    const nodes = [{ id: 'intro', type: 'Text', text: 'First' }, { id: 'next', type: 'Text', text: 'Second' }];
    const completion = Promise.withResolvers();
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes, connections: [] }) },
        async runWorkflow(input, options) {
            options.validateBeforeRun();
            await completion.promise;
            return {
                workflowId: 'wf-a', outcome: 'completed', started: true, executed: true,
                nodeResults: input.selectedNodeIds.map(nodeId => ({
                    nodeId, succeeded: true, texts: [nodes.find(node => node.id === nodeId).text], error: 'hidden',
                    images: ['data:image/png;base64,YQ=='], mediaAssetKeys: ['media:a']
                }))
            };
        }
    });
    const { revision } = await dispatch('read_canvas');
    const run = await dispatch('run_workflow', { workflowId, revision, nodeIds: ['next'] });
    assert.equal(run.status, 'running');
    assert.equal((await dispatch('get_workflow_run', run)).status, 'running');
    workflowId = 'wf-b';
    completion.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const result = await dispatch('get_workflow_run', run);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.nodeResults, [{ nodeId: 'next', succeeded: true, texts: ['Second'], imageCount: 1, mediaAssetKeys: ['media:a'] }]);
    await assert.rejects(dispatch('get_workflow_run', { ...run, workflowId: 'wf-b' }), { code: 'run_not_found' });
    await assert.rejects(dispatch('run_workflow', { workflowId: 'wf-a', revision }), { code: 'wrong_workflow' });
});

test('reads only the exact bounded inline image captured by the requested run', async () => {
    const workflowId = 'wf-a';
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes: [], connections: [] }) },
        async runWorkflow() {
            return { workflowId, outcome: 'completed', nodeResults: [{
                nodeId: 'image', succeeded: true, images: [
                    'data:image/png;base64,YQ==',
                    'https://example.test/image.png',
                    'data:image/svg+xml;base64,YQ==',
                    'data:image/png;base64,' + 'A'.repeat(6_000_001)
                ]
            }] };
        }
    });
    const { revision } = await dispatch('read_canvas');
    const { runId } = await dispatch('run_workflow', { workflowId, revision });
    await new Promise(resolve => setImmediate(resolve));
    const query = { workflowId, runId, nodeId: 'image' };
    assert.deepEqual(await dispatch('get_run_image', { ...query, index: 0 }), { mimeType: 'image/png', data: 'YQ==' });
    for (const index of [1, 2, 3]) {
        await assert.rejects(dispatch('get_run_image', { ...query, index }), { code: 'image_unavailable' });
    }
    await assert.rejects(dispatch('get_run_image', { ...query, nodeId: 'other', index: 0 }), { code: 'image_unavailable' });
    await assert.rejects(dispatch('get_run_image', { ...query, workflowId: 'wf-b', index: 0 }), { code: 'run_not_found' });
});

test('pages successful run node statuses within the encoded response budget', async () => {
    const workflowId = 'wf-a';
    const nodeResults = Array.from({ length: 14 }, (_, index) => ({
        nodeId: `node-${index}`, succeeded: true, texts: Array(5).fill('😀'.repeat(2000))
    }));
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes: [], connections: [] }) },
        async runWorkflow() {
            return { workflowId, outcome: 'completed', nodeResults };
        }
    });
    const { revision } = await dispatch('read_canvas');
    const { runId } = await dispatch('run_workflow', { workflowId, revision });
    await new Promise(resolve => setImmediate(resolve));
    const all = [];
    let offset = 0;
    do {
        const page = await dispatch('get_workflow_run', { workflowId, runId, offset });
        assert.equal(page.offset, offset);
        assert.equal(page.total, nodeResults.length);
        assert.ok(page.nodeResults.length > 0 && page.nodeResults.length < page.total);
        assert.ok(JSON.stringify(page).replace(/[^\x00-\x7e]/g, '\\u0000').length < 1024 * 1024);
        all.push(...page.nodeResults);
        offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(all.map(node => node.nodeId), nodeResults.map(node => node.nodeId));
    assert.deepEqual(all.at(-1).texts, nodeResults.at(-1).texts);
    await assert.rejects(dispatch('get_workflow_run', { workflowId, runId, offset: -1 }), { code: 'invalid_arguments' });
});

test('retains paged node summaries past 100 even when text exceeds the run cache budget', async () => {
    const workflowId = 'wf-a';
    const nodeResults = Array.from({ length: 105 }, (_, index) => ({
        nodeId: `node-${index}`,
        ...(index === 100
            ? { succeeded: false, failureCategory: 'invalid_api_key', error: 'Untrusted provider detail: secret-value' }
            : { succeeded: true, texts: Array(5).fill('😀'.repeat(2000)) })
    }));
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes: [], connections: [] }) },
        runWorkflow: async () => ({ workflowId, outcome: 'completed', nodeResults })
    });
    const { revision } = await dispatch('read_canvas');
    const { runId } = await dispatch('run_workflow', { workflowId, revision });
    await new Promise(resolve => setImmediate(resolve));
    const all = [];
    let offset = 0;
    do {
        const page = await dispatch('get_workflow_run', { workflowId, runId, offset });
        assert.equal(page.total, nodeResults.length);
        assert.equal(page.nodeResultsOmitted, undefined);
        all.push(...page.nodeResults);
        offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(all.map(node => node.nodeId), nodeResults.map(node => node.nodeId));
    assert.equal(all[0].texts.length, 5);
    assert.equal(all[100].errorCode, 'node_invalid_api_key');
    assert.match(all[100].error, /供应商拒绝了 API 密钥/);
    assert.ok(!JSON.stringify(all).includes('secret-value'));
    assert.equal(all[104].detailsOmitted, true);
    assert.equal(all[104].texts, undefined);
});

test('reports stale launch guards and preflight failures on the accepted run ID', async () => {
    const workflowId = 'wf-a';
    const node = { id: 'source', type: 'Text', text: 'Original' };
    let invalidate = true;
    const { dispatch } = createCanvasMcpActions({
        canvasAdapter: { context: () => createCanvasContext({ workflowId, nodes: [node], connections: [] }) },
        async runWorkflow(_input, { validateBeforeRun }) {
            if (invalidate) node.text = 'Changed during launch';
            validateBeforeRun();
            return { started: false, reason: 'incomplete-model-configuration', error: 'private-path' };
        }
    });
    const run = async () => {
        const { revision } = await dispatch('read_canvas');
        const { runId } = await dispatch('run_workflow', { workflowId, revision });
        await new Promise(resolve => setImmediate(resolve));
        return dispatch('get_workflow_run', { workflowId, runId });
    };
    const stale = await run();
    assert.equal(stale.status, 'failed');
    assert.equal(stale.errorCode, 'stale_revision');
    invalidate = false;
    const blocked = await run();
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.errorCode, 'incomplete_model_configuration');
    assert.match(blocked.error, /检查目标节点的模型和供应商配置/);
    assert.ok(!JSON.stringify(blocked).includes('private-path'));
});
