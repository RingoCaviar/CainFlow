import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCommerceSceneShot, commerceImageSetSourceKey, confirmCommerceSceneShot } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import {
    getCommerceReferenceRevision, hasCommerceReferenceChange, projectCommerceReferences, verifyCommerceReferenceContent
} from '../js/features/ecommerce-image-set/commerce-reference-revision.js';
import { getCommerceRunPreflight, usesCommerceRunReferences } from '../js/features/execution/commerce-run-preflight.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import { projectCanvasRunScope } from '../js/features/ui/canvas-run-scope.js';
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

test('画布运行预检在发送上游请求前识别风格变更', () => {
    const { state, inspect } = fixture();
    state.nodes.set('style', { id: 'style', type: 'VisualStyle', data: { visualStyle: { palette: '暖棕' } } });
    state.connections.push({ from: { nodeId: 'style', port: 'style' }, to: { nodeId: 'commerce', port: 'style' }, type: 'style' });
    assert.match(inspect().issue.message, /画面风格已更新/);
});

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

test('commerce preflight blocks a replaced or reordered saved reference before a generation action', () => {
    const { plan, source, settings, inspect } = fixture({ mode: 'selected-only' });
    settings.plan.referenceRevision = 'v1:["media:original","media:second"]';
    source.data.mediaAssetKeys = ['media:original', 'media:second'];
    assert.equal(inspect().issue, null);
    const approved = inspect().approvalKey;

    source.data.mediaAssetKeys.reverse();
    assert.match(inspect().issue?.message || '', /参考图已变更/);
    assert.notEqual(inspect().approvalKey, approved);
    source.data.mediaAssetKeys = ['media:replacement', 'media:second'];
    plan.commerceNodeId = 'commerce';
    for (const action of ['replan-shot', 'generate', 'retry', 'fill', 'select-candidate']) {
        plan.commerceAction = action;
        assert.match(inspect().issue?.message || '', /参考图已变更/, action);
    }
    for (const action of ['analyze', 'plan']) {
        plan.commerceAction = action;
        assert.equal(inspect().issue, null, action);
    }
});

test('legacy commerce provenance can be verified from local originals without adopting a replaced reference', async () => {
    const { source, settings, state } = fixture({ mode: 'selected-only', sourceType: 'ImageImport' });
    const original = 'data:image/png;base64,b2xk';
    const replacement = 'data:image/png;base64,bmV3';
    source.data.mediaAssetKeys = ['media:original'];
    settings.plan.sourceKey = await commerceImageSetSourceKey({ settings, references: [original] });
    const assets = new Map([['media:original', original], ['media:replacement', replacement]]);
    const reads = [];
    const verify = () => verifyCommerceReferenceContent({ settings, projection: projectCommerceReferences(state, 'commerce'),
        async readAsset(key) { reads.push(key); return assets.get(key); } });

    const matched = await verify();
    assert.equal(matched.status, 'matched');
    assert.equal(matched.referenceRevision, 'v1:["media:original"]');
    assert.ok(matched.referenceContentKey);
    assert.deepEqual(reads, ['media:original']);

    source.data.mediaAssetKeys = ['media:replacement'];
    assert.equal((await verify()).status, 'stale');
    settings.plan.stale = true;
    assert.equal((await verify()).status, 'unknown');
    assert.deepEqual(reads, ['media:original', 'media:replacement']);

    settings.plan.referenceContentKey = matched.referenceContentKey;
    assert.equal((await verify()).status, 'stale', 'reference provenance is independent of stale plan settings');
    source.importMode = 'url';
    source.imageUrl = 'https://fixture.test/reference.png';
    assert.equal((await verify()).status, 'unknown');
    assert.deepEqual(reads, ['media:original', 'media:replacement', 'media:replacement']);
});

test('disconnecting or disabling a planned commerce reference is stale while image hydration is unknown', () => {
    const { state, plan, source, settings, inspect } = fixture({ mode: 'selected-only', sourceType: 'ImageImport' });
    settings.plan.referenceRevision = 'v1:["media:original"]';
    const project = () => projectCommerceReferences(state, 'commerce');
    assert.equal(hasCommerceReferenceChange(settings, project()), false);
    assert.equal(inspect().issue.action, 'references');
    source.data.mediaAssetKeys = ['media:original'];
    state.runningNodeIds = new Set([source.id]);
    assert.equal(hasCommerceReferenceChange(settings, project()), false);
    state.runningNodeIds.clear();

    source.enabled = false;
    assert.equal(getCommerceReferenceRevision(project()), '');
    assert.match(inspect().issue.message, /参考图已变更/);
    source.enabled = true;
    state.connections = [];
    plan.inputConnectionsByNode.commerce = [];
    assert.equal(getCommerceReferenceRevision(project()), '');
    assert.match(inspect().issue.message, /参考图已变更/);

    delete settings.plan.referenceRevision;
    assert.equal(hasCommerceReferenceChange(settings, project()), true);
    assert.match(inspect().issue.message, /参考图已变更/, 'a legacy plan also loses its active approval after disconnecting all sources');
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

test('commerce run preview preserves finalized outputs and excludes them from paid calls', () => {
    const { state, plan, source, settings, inspect } = fixture({ mode: 'selected-only' });
    source.data.mediaAssetKeys = ['media:existing-reference'];
    const baseline = inspect();
    settings.results = [{ shotId: 'angle', status: 'completed', assetKey: 'media:finalized-angle', finalized: true }];
    state.providers[0].apikey = '';
    const partial = inspect();
    assert.equal(partial.issue, null, 'a finalized model-generated image needs no model credentials');
    assert.deepEqual([partial.shotCount, partial.generateCount, partial.referenceCount, partial.finalizedCount], [2, 0, 1, 1]);
    assert.notEqual(partial.approvalKey, baseline.approvalKey);
    assert.equal(usesCommerceRunReferences(state.nodes.get('commerce'), plan), true, 'applying an undecided reference still needs its image');

    settings.results.push({ shotId: 'main', status: 'completed', assetKey: 'media:finalized-main', finalized: true });
    delete source.data.mediaAssetKeys;
    const allFinalized = inspect();
    assert.equal(allFinalized.issue, null);
    assert.deepEqual([allFinalized.shotCount, allFinalized.generateCount, allFinalized.referenceCount, allFinalized.finalizedCount], [2, 0, 0, 2]);
    assert.equal(usesCommerceRunReferences(state.nodes.get('commerce'), plan), false);
});

test('canvas run approval counts every commerce candidate request and excludes original and finalized slots', () => {
    const { settings, state, plan, inspect } = fixture();
    settings.selectedShotIds.push('feature');
    settings.plan.shots.push({ id: 'feature', prompt: '用特写展示杯盖' });
    const preview = () => projectCanvasRunScope({ state, plan, isFixedTextChatWithCachedResult: () => false });
    const initial = preview();
    assert.equal(initial.commerce[0].generateCount, 2);

    settings.candidateCount = 8;
    const expanded = preview();
    assert.deepEqual([expanded.commerce[0].shotCount, expanded.commerce[0].generateCount, expanded.commerce[0].referenceCount], [3, 16, 1]);
    assert.notEqual(expanded.scopeKey, initial.scopeKey);

    settings.results = [{ shotId: 'angle', status: 'completed', assetKey: 'media:locked-angle', finalized: true }];
    assert.deepEqual([inspect().generateCount, inspect().referenceCount, inspect().finalizedCount], [8, 1, 1]);
    settings.results.push({ shotId: 'feature', status: 'completed', assetKey: 'media:locked-feature', finalized: true });
    assert.equal(inspect().generateCount, 0);
    const finalized = preview();
    settings.candidateCount = 4;
    assert.equal(preview().scopeKey, finalized.scopeKey, 'candidate count cannot affect a reference-only run');
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

test('a selected downstream run rejects old commerce output after the reference was replaced', async () => {
    const { state, plan, source, settings } = fixture({ mode: 'selected-only', sourceType: 'ImageImport' });
    settings.plan.referenceRevision = 'v1:["media:original"]';
    source.data.mediaAssetKeys = ['media:replacement'];
    const commerce = state.nodes.get('commerce');
    commerce.data.mediaAssetKeys = ['media:old-result'];
    const downstream = { id: 'consumer', type: 'ImagePreview', data: {} };
    state.nodes.set(downstream.id, downstream);
    const edge = { id: 'reuse', type: 'image', from: { nodeId: commerce.id, port: 'image' },
        to: { nodeId: downstream.id, port: 'image' } };
    state.connections.push(edge);
    plan.executionOrder = plan.nodeIds = [downstream.id];
    plan.scopeNodeSet = new Set(plan.nodeIds);
    plan.inputConnectionsByNode[downstream.id] = [edge];
    const calls = [];
    const runner = createWorkflowRunnerApi({ state, nodeConfigs: {}, documentRef: {
        getElementById: () => null, defaultView: { requestAnimationFrame: run => run() }
    }, confirmRef: () => true, normalizeRunOptions: value => value, resolveExecutionPlan: () => plan,
    getCachedOutputValue: () => 'old-result', executeNode: async node => calls.push(node.id), showToast() {} });
    const blocked = await runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [downstream.id] });
    assert.equal(blocked.reason, 'commerce-preflight');
    assert.equal(blocked.nodeId, commerce.id);
    assert.match(blocked.error, /参考图已变更/);
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

test('candidate selection dispatches without restoring reference inputs or capturing scene images', async () => {
    const { state, plan } = fixture({ mode: 'selected-only' });
    Object.assign(plan, { commerceNodeId: 'commerce', commerceAction: 'select-candidate', commerceShotId: 'angle',
        commerceCandidateKey: 'media:older' });
    assert.equal(usesCommerceRunReferences(state.nodes.get('commerce'), plan), false);
    const { calls, workflow, runtime } = detachedRuntimeFixture(state, plan);
    await runtime.runWorkflowInContext(workflow, {}, plan, { waitForCompletion: true });
    assert.deepEqual(calls, ['dispatch', 'dispose']);
});

test('panel cancellation preserves a commerce batch that is saving, while stopping its branch still aborts it', async () => {
    const { state, plan } = fixture({ mode: 'selected-only' });
    Object.assign(plan, { commerceNodeId: 'commerce', commerceAction: 'generate' });
    const { workflow, runtime, context } = detachedRuntimeFixture(state, plan);
    const saving = Promise.withResolvers();
    const saved = Promise.withResolvers();
    context.runner.runWorkflow = async (_input, { signal }) => {
        const node = state.nodes.get('commerce');
        state.runningNodeIds = new Set([node.id]);
        node.commerceShotPreviews = { main: { status: 'completed' }, angle: { status: 'completed' } };
        saving.resolve(signal);
        await saved.promise;
        return { started: true, executed: true, outcome: signal.aborted ? 'stopped' : 'completed' };
    };
    context.runner.cancelRunningNode = () => true;
    const run = runtime.runWorkflowInContext(workflow, {}, plan, { waitForCompletion: true,
        commercePanelSignal: new AbortController().signal });
    const signal = await saving.promise;
    try {
        assert.equal(runtime.cancelCommerceImageSet(workflow, 'commerce'), false);
        assert.equal(signal.aborted, false);
        assert.equal(runtime.cancelCommerceImageSet(workflow, 'commerce', undefined, { stopBranch: true }), true);
        assert.equal(signal.aborted, true);
    } finally {
        saved.resolve();
        await run;
    }
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
