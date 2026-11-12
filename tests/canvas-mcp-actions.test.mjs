import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasMcpActions } from '../js/features/canvas-mcp/canvas-mcp-actions.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';

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
