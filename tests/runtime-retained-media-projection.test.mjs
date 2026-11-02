import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { createWorkflowRuntimeManager, applyImageSaveMediaState } from '../js/features/workflow/workflow-runtime-manager.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';

const image = 'data:image/png;base64,OLD';
const nextImage = 'data:image/png;base64,NEW';
const video = { id: 'old-video', assetKey: 'media:old-video', url: '/api/storage/assets/media%3Aold-video' };
const nextVideo = { id: 'new-video', assetKey: 'media:new-video', url: '/api/storage/assets/media%3Anew-video' };
const quiet = () => {};
const clone = value => JSON.parse(JSON.stringify(value));

function harness(type, runtimeData = {}, runtimeState = {}) {
    const id = type === 'ImagePreview' ? 'preview' : 'save';
    const element = () => ({ id, style: { left: '23px', top: '45px', width: '300px', height: '220px' },
        classList: { add: quiet, remove: quiet, toggle: quiet, contains: () => false }, querySelector: () => null, querySelectorAll: () => [] });
    const visible = { id, type, enabled: true, data: {}, imagePreviewIndex: 0, el: element() };
    const runtimeNode = { id, type, enabled: true, data: clone(runtimeData), isSucceeded: false, el: element(), ...runtimeState };
    const state = { nodes: new Map([[id, visible]]), connections: [], selectedNodes: new Set(),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map() };
    const savePreview = { dataset: {} };
    const buttons = { manual: { disabled: true }, full: { disabled: true }, controls: { style: { display: 'none' } } };
    const controls = new Map([[`#${id}-save-preview`, savePreview], [`#${id}-manual-save`, buttons.manual],
        [`#${id}-view-full`, buttons.full], [`#${id}-controls`, buttons.controls]]);
    visible.el.querySelector = selector => controls.get(selector) || null;
    const documentRef = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: quiet };
    const windowRef = { setInterval: () => 1, clearInterval: quiet, setTimeout: () => 1, clearTimeout: quiet,
        requestAnimationFrame: () => 1, addEventListener: quiet };
    const mediaWrites = [];
    const media = createMediaControllerApi({ state, getNodeById: nodeId => state.nodes.get(nodeId), documentRef, windowRef,
        getActiveWorkflowId: () => 'workflow-a', referenceMediaAsset: async (...args) => { mediaWrites.push(args); return true; },
        removeMediaReference: async (...args) => { mediaWrites.push(args); return true; },
        saveWorkflowNodeMediaAssets: async (...args) => { mediaWrites.push(args); return []; },
        showToast: quiet, addLog: quiet, scheduleSave: quiet, estimateDataUrlSize: () => 0, getImageResolution: async () => null });
    const workflow = { workflowId: 'workflow-a', workflowName: 'test' };
    const manager = createWorkflowRuntimeManager({ state, nodeConfigs: {}, documentRef, windowRef, confirmRef: () => true,
        showToast: quiet, addLog: quiet, scheduleSave: quiet,
        syncImagePreviewNode: media.syncImagePreviewNode, syncImageSaveNode: media.syncImageSaveNode,
        getWorkflowDesk: () => ({ workflow: () => ({ runningChanged: quiet }) }),
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: workflow.workflowId, label: workflow.workflowName }),
            updateWorkflowTabDataById: quiet, projectWorkflowRunningStateById: quiet, setWorkflowRunResultById: quiet }),
        // The execution result is fixed; projection and the visible media consumer are real.
        createRunContext: () => ({ id: `run-${id}`, ...workflow, nodeRunStarted: true,
            state: { nodes: new Map([[id, runtimeNode]]), connections: [], runningNodeIds: new Set() },
            baseNodeIds: new Set([id]), baseConnectionIds: new Set(),
            resolveExecutionPlan: () => ({ executionOrder: [id] }), waitForImageRestores: async () => {},
            runner: { runWorkflow: async () => ({ started: true, executed: true, outcome: 'completed', reason: 'finished' }) },
            serialize: () => ({ nodes: [runtimeNode], connections: [] }), dispose: quiet }) });
    return { visible, runtimeNode, media, mediaWrites, savePreview, buttons, state, documentRef, windowRef,
        project: () => manager.runWorkflowInContext(workflow, { nodes: [runtimeNode], connections: [] }, null, { waitForCompletion: true }) };
}

test('a stale background Preview remains stale when its retained batch is projected to the visible workflow', async () => {
    const { visible, project, mediaWrites } = harness('ImagePreview', {
        imageList: [image], mediaAssetKeys: ['media:old-image'], imageCount: 1, imageAssetReady: true
    }, { previewInputState: 'stale' });
    await project();
    assert.equal(visible.previewInputState, 'stale');
    assert.deepEqual(visible.data.imageList, [image]);
    assert.deepEqual(visible.data.mediaAssetKeys, ['media:old-image']);
    assert.deepEqual(mediaWrites, [], 'projecting existing output does not write or release Media asset owners');
    assert.deepEqual(visible.el.style, { left: '23px', top: '45px', width: '300px', height: '220px' });
});

test('running a Save without inputs preserves a released but recoverable image batch as stale', async () => {
    const fixture = harness('ImageSave');
    fixture.visible.data = { mediaAssetKeys: ['media:retained-image'], imageCount: 1, imageMemoryReleased: true };
    const core = createExecutionCoreApi({ state: fixture.state, nodeConfigs: {}, documentRef: fixture.documentRef, windowRef: fixture.windowRef,
        syncImageSaveNode: fixture.media.syncImageSaveNode, autoSaveToDir: async () => {} });
    await core.nodeHandlers.ImageSave(fixture.visible, {});
    assert.equal(fixture.visible.saveInputState, 'stale');
    assert.equal(fixture.savePreview.dataset.saveMessage, '无有效输入，保留原有媒体，未更新');
    assert.deepEqual(fixture.visible.data.mediaAssetKeys, ['media:retained-image']);
    assert.deepEqual(fixture.mediaWrites, []);
});

test('running a Preview without inputs marks retained output stale without treating it as a new input', async () => {
    const fixture = harness('ImagePreview');
    fixture.visible.data = { imageList: [image], mediaAssetKeys: ['media:retained-image'], imageCount: 1 };
    const core = createExecutionCoreApi({ state: fixture.state, nodeConfigs: {}, documentRef: fixture.documentRef, windowRef: fixture.windowRef,
        syncImagePreviewNode: fixture.media.syncImagePreviewNode });
    await core.nodeHandlers.ImagePreview(fixture.visible, {});
    assert.equal(fixture.visible.previewInputState, 'stale');
    assert.deepEqual(fixture.visible.data.imageList, [image]);
    assert.deepEqual(fixture.mediaWrites, []);
});

test('background Save projection distinguishes updated images from retained video and updated video from retained images', async () => {
    for (const scenario of [
        { images: [nextImage], videos: [video], message: '视频输入未更新，保留原视频；图片已更新' },
        { images: [image], videos: [nextVideo], message: '图片输入未更新，保留原图片；视频已更新' }
    ]) {
        const { visible, project, mediaWrites, savePreview } = harness('ImageSave', {
            imageList: scenario.images, imageCount: 1, mediaAssetKeys: ['media:retained-image'], imageAssetReady: true,
            videos: scenario.videos, video: scenario.videos[0]
        }, { saveInputState: 'stale', saveInputMessage: scenario.message });
        await project();
        assert.equal(visible.saveInputState, 'stale');
        assert.equal(savePreview.dataset.saveState, 'stale');
        assert.equal(savePreview.dataset.saveMessage, scenario.message);
        assert.deepEqual(visible.data.imageList, scenario.images);
        assert.deepEqual(visible.data.videos, scenario.videos);
        assert.deepEqual(mediaWrites, []);
    }
});

test('empty and current runtime display results replace obsolete visible state without rewriting media owners', async () => {
    for (const type of ['ImagePreview', 'ImageSave']) {
        for (const status of ['empty', 'current']) {
            const data = status === 'current' ? { imageList: [nextImage], mediaAssetKeys: ['media:new-image'], imageCount: 1, imageAssetReady: true,
                ...(type === 'ImageSave' ? { videos: [nextVideo], video: nextVideo } : {}) } : {};
            const stateField = type === 'ImagePreview' ? 'previewInputState' : 'saveInputState';
            const fixture = harness(type, data, { [stateField]: status, saveInputMessage: '' });
            fixture.visible.data = { imageList: [image], mediaAssetKeys: ['media:old-image'], imageCount: 1, videos: [video], video };
            fixture.visible[stateField] = 'stale';
            fixture.savePreview.dataset.saveMessage = '旧提示';
            await fixture.project();
            assert.equal(fixture.visible[stateField], status);
            assert.deepEqual(fixture.visible.data.mediaAssetKeys, status === 'current' ? ['media:new-image'] : undefined);
            assert.deepEqual(fixture.visible.data.imageList, status === 'current' ? [nextImage] : undefined);
            if (type === 'ImageSave') {
                assert.equal(fixture.savePreview.dataset.saveMessage, undefined);
                assert.deepEqual(fixture.visible.data.videos, status === 'current' ? [nextVideo] : undefined);
                assert.equal(fixture.buttons.manual.disabled, status === 'empty');
                assert.equal(fixture.buttons.full.disabled, status === 'empty');
            } else assert.equal(fixture.buttons.controls.style.display, status === 'current' ? 'flex' : 'none');
            assert.deepEqual(fixture.mediaWrites, []);
        }
    }
});

test('runtime projection preserves missing original positions and the visible browsing index', async () => {
    const integrity = { state: 'missing', mediaType: 'image', itemCount: 2, missingItems: [{ position: 0, assetKey: 'media:missing' }] };
    for (const type of ['ImagePreview', 'ImageSave']) {
        const stateField = type === 'ImagePreview' ? 'previewInputState' : 'saveInputState';
        const fixture = harness(type, { imageList: [nextImage], imageCount: 2, mediaAssetKeys: ['media:missing', 'media:second'],
            mediaIntegrity: integrity, imageAssetReady: true }, { [stateField]: 'stale', imagePreviewIndex: 1 });
        await fixture.project();
        assert.equal(fixture.visible[stateField], 'stale');
        assert.equal(fixture.visible.imagePreviewIndex, 1);
        assert.deepEqual(fixture.visible.data.mediaAssetKeys, ['media:missing', 'media:second']);
        assert.deepEqual(fixture.visible.data.mediaIntegrity, integrity);
        assert.notEqual(fixture.visible.data.mediaIntegrity, fixture.runtimeNode.data.mediaIntegrity);
        assert.deepEqual(fixture.mediaWrites, []);
    }
});

test('visible and background Save updates share partial-input and unsupported-URL decisions', async () => {
    for (const scenario of [
        { input: { images: [nextImage], videos: [] }, state: 'stale', message: '视频输入未更新，保留原视频；图片已更新' },
        { input: { images: [], videos: [nextVideo] }, state: 'stale', message: '图片输入未更新，保留原图片；视频已更新' },
        { input: { images: [], videos: [] }, state: 'stale', message: '无有效输入，保留原有媒体，未更新' },
        { input: { images: [nextImage], videos: [nextVideo] }, state: 'current', message: '' },
        { input: { images: ['https://example.test/remote.png'], videos: [] }, state: 'stale', message: 'URL 图片不支持保存，原有媒体未更新' }
    ]) {
        const fixture = harness('ImageSave');
        fixture.visible.data = { imageList: [image], mediaAssetKeys: ['media:old-image'], imageCount: 1, imageAssetReady: true, videos: [video], video };
        const detached = { type: 'ImageSave', data: clone(fixture.visible.data) };
        const result = applyImageSaveMediaState(detached, scenario.input);
        await fixture.media.syncImageSaveNode('save', scenario.input);
        assert.equal(detached.saveInputState, scenario.state);
        assert.equal(fixture.visible.saveInputState, scenario.state);
        assert.equal(detached.saveInputMessage, scenario.message);
        assert.equal(fixture.savePreview.dataset.saveMessage || '', scenario.message);
        if (scenario.input.images.some(value => value.startsWith('https:'))) {
            assert.deepEqual(result.input.images, []);
            assert.deepEqual(fixture.visible.data.imageList, [image]);
        }
    }
    const empty = { data: {} };
    applyImageSaveMediaState(empty, { images: [], videos: [] });
    assert.equal(empty.saveInputState, 'empty');
    assert.equal(empty.saveInputMessage, '');
});

for (const type of ['ImageResize', 'ColorReset']) {
    test(`${type} runtime projection retains durable output identity independently of preview bytes`, async () => {
        const metadata = { mediaAssetKeys: ['media:processed'], imageAssetKey: 'media:processed', imageCount: 1,
            imageAssetReady: true, mediaIntegrity: { state: 'ready', itemCount: 1 } };
        for (const imageList of [[nextImage], []]) {
            const fixture = harness(type, { ...metadata, imageList }, { isSucceeded: true });
            fixture.visible.data = { mediaAssetKeys: ['media:old'], imageAssetKey: 'media:old' };
            await fixture.project();
            for (const [field, value] of Object.entries(metadata)) assert.deepEqual(fixture.visible.data[field], value);
            assert.notEqual(fixture.visible.data.mediaAssetKeys, fixture.runtimeNode.data.mediaAssetKeys);
            assert.notEqual(fixture.visible.data.mediaIntegrity, fixture.runtimeNode.data.mediaIntegrity);
            assert.deepEqual(fixture.mediaWrites, [], 'projection uses the runtime-owned asset without duplicating it');
        }
    });
}
