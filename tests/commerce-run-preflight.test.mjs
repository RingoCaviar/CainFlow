import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCommerceSceneShot, confirmCommerceSceneShot } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import { getCommerceRunPreflight } from '../js/features/execution/commerce-run-preflight.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';
import '../js/features/execution/protocols/openai.js';

function fixture({ mode = 'target-node', confirmed = true, sourceType = 'ImageGenerate' } = {}) {
    const settings = {
        platformId: 'amazon', selectedShotIds: ['main', 'angle'], imageModelId: 'image', imageProviderId: 'provider',
        plan: { version: 1, platformId: 'amazon', sourceKey: 'fixture', confirmed, sellingPoints: [],
            shots: [{ id: 'main' }, { id: 'angle', prompt: '补一张侧面图' }] }
    };
    const commerce = { id: 'commerce', type: 'ECommerceImageSet', data: { commerceImageSet: settings } };
    const source = { id: 'source', type: sourceType, apiConfigId: 'image', providerId: 'provider', data: {} };
    const edge = { id: 'reference', type: 'image', from: { nodeId: source.id, port: 'image' },
        to: { nodeId: commerce.id, port: 'referenceImages' } };
    const models = [{ id: 'image', modelId: 'gpt-image-2', protocol: 'openai', taskType: 'image', providerIds: ['provider'] }];
    const providers = [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }];
    const state = { nodes: new Map([[source.id, source], [commerce.id, commerce]]), connections: [edge], models, providers };
    const executionOrder = mode === 'selected-only' ? [commerce.id] : [source.id, commerce.id];
    const plan = { mode, targetNodeId: commerce.id, executionOrder, nodeIds: executionOrder, scopeNodeSet: new Set(executionOrder),
        inputConnectionsByNode: { [commerce.id]: [edge] } };
    const inspect = () => getCommerceRunPreflight({ state, plan })[0];
    return { state, plan, source, settings, inspect };
}

test('commerce preflight distinguishes changing upstreams, reusable sources, and missing inputs', () => {
    const rerun = fixture();
    const preview = rerun.inspect();
    assert.equal(preview.upstreamWillRun, true);
    assert.equal(preview.issue, null, 'a planned producer can generate its first image');
    assert.deepEqual([preview.shotCount, preview.generateCount, preview.referenceCount], [2, 1, 1]);

    const selected = fixture({ mode: 'selected-only' });
    assert.equal(selected.inspect().issue.action, 'references');
    selected.source.data.mediaAssetKeys = ['media:saved-original'];
    assert.equal(selected.inspect().issue, null, 'a durable media identity is usable before local restore');
    assert.equal(selected.inspect().upstreamWillRun, false);
    selected.source.data.mediaIntegrity = { state: 'missing', missingItems: [{ position: 0 }] };
    assert.equal(selected.inspect().issue.action, 'references');

    const emptyImport = fixture({ sourceType: 'ImageImport' });
    assert.equal(emptyImport.inspect().issue.action, 'references', 'executing an empty import cannot generate an image');
    assert.equal(emptyImport.inspect().upstreamWillRun, false);
});

test('a passive preview needs a planned input or a retained original to supply commerce', () => {
    const { state, plan, source, inspect } = fixture({ sourceType: 'ImagePreview' });
    assert.equal(inspect().issue?.action, 'references');
    assert.equal(inspect().upstreamWillRun, false);
    source.data.mediaAssetKeys = ['media:preview-original'];
    assert.equal(inspect().issue, null, 'a preview can still supply its retained result');
    delete source.data.mediaAssetKeys;
    const upstream = { id: 'upstream', type: 'ImageGenerate', enabled: false };
    state.nodes.set(upstream.id, upstream);
    plan.inputConnectionsByNode[source.id] = [{ from: { nodeId: upstream.id, port: 'image' },
        to: { nodeId: source.id, port: 'image' } }];
    assert.equal(inspect().issue?.action, 'references');
    upstream.enabled = true;
    assert.equal(inspect().issue?.action, 'references', 'an out-of-scope input must already have an output');
    plan.scopeNodeSet.add(upstream.id);
    assert.equal(inspect().issue, null);
    assert.equal(inspect().upstreamWillRun, true);
});

test('commerce preflight respects dedicated phases and fingerprints approved shot selection', () => {
    const f = fixture({ confirmed: false });
    assert.equal(f.inspect().issue.action, 'confirm');
    for (const action of ['analyze', 'plan', 'replan-shot', 'generate', 'retry', 'fill']) {
        f.plan.commerceNodeId = 'commerce';
        f.plan.commerceAction = action;
        assert.equal(f.inspect().issue, null, `dedicated ${action} retains its own checks`);
    }
    delete f.plan.commerceAction;
    f.settings.plan.confirmed = true;
    const approved = f.inspect();
    assert.equal(approved.unfinishedCount, 2);
    f.settings.results = [{ shotId: 'main', status: 'completed', assetKey: 'media:saved-original' }];
    assert.equal(f.inspect().hasCompleted, true);
    assert.equal(f.inspect().unfinishedCount, 1);
    assert.notEqual(f.inspect().approvalKey, approved.approvalKey);
    const completedKey = f.inspect().approvalKey;
    f.settings.plan.shots[1].prompt = '一张新的侧面图';
    assert.notEqual(f.inspect().approvalKey, completedKey);
    f.state.providers[0].apikey = '';
    assert.equal(f.inspect().issue.action, 'configure');
    f.settings.plan.stale = true;
    assert.equal(f.inspect().issue.action, 'plan');
});

test('a supplemental scene changes the canvas run scope only after individual confirmation', () => {
    const { settings, inspect } = fixture();
    settings.results = [
        { shotId: 'main', status: 'completed', assetKey: 'media:original' },
        { shotId: 'angle', status: 'completed', assetKey: 'media:angle-result' }
    ];
    const baseline = inspect();
    const scene = appendCommerceSceneShot(settings, 'gallery');
    assert.ok(scene);
    assert.deepEqual(inspect(), baseline);
    scene.prompt = '在窗边展示商品的真实外观。';
    scene.sceneSummary = '自然光窗边';
    assert.deepEqual(inspect(), baseline, 'a drafted scene is outside the pending paid run');
    assert.equal(confirmCommerceSceneShot(settings, scene.id), true);
    const ready = inspect();
    assert.equal(ready.issue, null);
    assert.deepEqual([ready.shotCount, ready.generateCount, ready.unfinishedCount], [3, 2, 1]);
    assert.notEqual(ready.approvalKey, baseline.approvalKey);
});

test('the shared runner rejects unconfirmed commerce before executing its paid upstream', async () => {
    const { state, plan } = fixture({ confirmed: false });
    const calls = [];
    const runner = createWorkflowRunnerApi({ state, nodeConfigs: {}, documentRef: {
        getElementById: () => null, defaultView: { requestAnimationFrame: run => run() }
    }, confirmRef: () => true, normalizeRunOptions: value => value, resolveExecutionPlan: () => plan,
    executeNode: async node => calls.push(node.id), showToast() {} });
    const blocked = await runner.runWorkflow({ mode: 'target-node', targetNodeId: 'commerce' });
    assert.equal(blocked.reason, 'commerce-preflight');
    assert.match(blocked.error, /确认/);
    assert.deepEqual(calls, []);
});

function detachedRuntimeFixture(state, plan) {
    const calls = [];
    const workflow = { workflowId: 'workflow-id', workflowName: '测试工作流' };
    const context = { ...workflow, id: 'context', state, resolveExecutionPlan: () => plan,
        waitForImageRestores: async () => calls.push('restore'),
        captureSceneReferenceImages: async () => calls.push('capture'),
        runner: {
            runWorkflow: async () => calls.push('dispatch'),
            resumeImageNodeBranch: async id => {
                calls.push(`resume:${id}`);
                return { started: true, executed: true, outcome: 'completed' };
            }
        },
        serialize: () => ({ nodes: [], connections: [] }), dispose: () => calls.push('dispose') };
    const runtime = createWorkflowRuntimeManager({ state, nodeConfigs: {}, documentRef: { getElementById: () => null },
        windowRef: {}, confirmRef: () => true,
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: workflow.workflowId }) }),
        getWorkflowDesk: () => ({ workflow: () => ({ runningChanged() {} }) }),
        createRunContext: () => context, addLog() {}, scheduleSave() {},
        showToast() {} });
    return { calls, workflow, runtime, context };
}

test('the detached runtime reports the commerce blocker before source restoration or run dispatch', async () => {
    const { state, plan } = fixture({ confirmed: false });
    const { calls, workflow, runtime } = detachedRuntimeFixture(state, plan);
    const blocked = await runtime.runWorkflowInContext(workflow, {}, {}, { waitForCompletion: true });
    assert.deepEqual({ started: blocked.started, executed: blocked.executed, reason: blocked.reason, nodeId: blocked.nodeId },
        { started: false, executed: false, reason: 'commerce-preflight', nodeId: 'commerce' });
    assert.deepEqual(calls, ['dispose']);
});

test('resuming an already submitted image task does not validate an upstream commerce plan', async () => {
    const { state, plan } = fixture({ confirmed: false });
    const edge = { id: 'resume-reference', type: 'image', from: { nodeId: 'commerce', port: 'image' },
        to: { nodeId: 'source', port: 'referenceImages' } };
    plan.executionOrder = ['commerce', 'source'];
    plan.targetNodeId = 'source';
    plan.inputConnectionsByNode = { source: [edge] };
    state.connections = [edge];
    const { calls, workflow, runtime, context } = detachedRuntimeFixture(state, plan);
    assert.equal(await runtime.runWorkflowInContext(workflow, {}, { mode: plan.mode, targetNodeId: plan.targetNodeId },
        { resumeNodeId: 'source' }), true);
    await context.promise;
    assert.ok(calls.includes('resume:source'));
    assert.ok(!calls.includes('dispatch'));
});
