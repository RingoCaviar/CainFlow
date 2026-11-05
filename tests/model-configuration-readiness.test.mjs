import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelConfigurationIssue, getNodeModelConfigurationIssue } from '../js/features/execution/model-configuration-readiness.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';

const provider = { id: 'p', endpoint: 'http://127.0.0.1:8000/v1', apikey: '' };
const model = { id: 'image', modelId: 'local-image', protocol: 'openai', taskType: 'image', providerIds: ['p'] };

test('configuration checks identify a repairable field without requiring credentials for local providers', () => {
    assert.equal(getModelConfigurationIssue({ model, providers: [provider], taskType: 'image' }), null);
    assert.equal(getModelConfigurationIssue({ model: { ...model, modelId: '' }, providers: [provider], taskType: 'image' }).target.field, 'modelId');
    assert.equal(getModelConfigurationIssue({ model: { ...model, protocol: 'removed-format' }, providers: [provider], taskType: 'image' }).target.field, 'protocol');
    assert.equal(getModelConfigurationIssue({ model, providers: [], taskType: 'image' }).target.field, 'providerIds');
    assert.deepEqual(getModelConfigurationIssue({ model, providers: [{ ...provider, endpoint: '' }], taskType: 'image' }).target, { providerId: 'p', field: 'endpoint' });
});

test('node configuration follows the visible model choice and ignores disabled nodes', () => {
    const node = { id: 'n', type: 'ImageGenerate', apiConfigId: 'image' };
    const state = { models: [model], providers: [provider] };
    assert.ok(getNodeModelConfigurationIssue({ state, node, documentRef: { getElementById: () => ({ value: '' }) } }));
    assert.equal(getNodeModelConfigurationIssue({ state, node: { ...node, enabled: false } }), null);
});

test('preflight preserves image results and skips reused fixed text while validating an explicit rerun', async () => {
    const fixed = { id: 'fixed', type: 'TextChat', enabled: true, isSucceeded: true, data: { text: 'cached prompt' } };
    const target = { id: 'target', type: 'ImageGenerate', enabled: true, data: { prompt: 'draft', imageList: ['retained-result'] } };
    const state = { nodes: new Map([[fixed.id, fixed], [target.id, target]]), models: [], providers: [] };
    const documentRef = { getElementById: id => id === 'fixed-fixed' ? { checked: true } : null,
        defaultView: { requestAnimationFrame: callback => callback() } };
    const runner = createWorkflowRunnerApi({ state, nodeConfigs: {}, documentRef, confirmRef: () => true,
        normalizeRunOptions: input => input || {},
        resolveExecutionPlan: () => ({ executionOrder: ['fixed', 'target'], nodeIds: ['fixed', 'target'] }),
        showToast: () => {} });
    const downstream = await runner.runWorkflow({ mode: 'target-node', targetNodeId: 'target' });
    assert.equal(downstream.nodeId, 'target', 'cached upstream does not require a model request');
    assert.equal(downstream.reason, 'incomplete-model-configuration');
    assert.deepEqual(target.data.imageList, ['retained-result']);
    const rerun = await runner.runWorkflow({ mode: 'target-node', targetNodeId: 'fixed' });
    assert.equal(rerun.nodeId, 'fixed', 'explicitly rerunning a cached node still requires configuration');
    assert.equal(rerun.reason, 'incomplete-model-configuration');
});
