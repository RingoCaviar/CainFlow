import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraControlNodeApi } from '../js/features/camera/camera-control-node-proxy.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';

function fixture(source = {}) {
    const node = { id: 'camera', type: 'CameraControl', data: { pitch: 23, yaw: -45, distance: 8, fov: 62, roll: 12, cameraPreviewImage: 'saved-snapshot' } };
    const upstream = { id: 'source', type: 'ImageGenerate', data: {}, ...source };
    const state = { activeWorkflowId: 'workflow-a', nodes: new Map([[node.id, node], [upstream.id, upstream]]), connections: [{ from: { nodeId: upstream.id, port: 'image' }, to: { nodeId: node.id, port: 'image' } }] };
    const documentRef = { getElementById: () => null };
    return { node, upstream, state, documentRef };
}

test('camera reference consumes the first canonical image while source browsing and complete batch stay unchanged', async () => {
    const images = ['data:image/png;base64,first', 'data:image/png;base64,last'];
    const { node, upstream, state, documentRef } = fixture({ data: { imageList: images }, imageData: images[1], imagePreviewIndex: 1 });
    const api = createCameraControlNodeApi({ state, documentRef });
    await api.refreshCameraControlPreview(node.id);
    assert.equal(node.data.image, images[0]);
    assert.deepEqual(upstream.data.imageList, images);
    assert.equal(upstream.imagePreviewIndex, 1);
    assert.equal(node.data.cameraPreviewImage, 'saved-snapshot');
});

test('camera reads the retained primary original by media identity when pixels are not mounted', async () => {
    const { node, state, documentRef } = fixture({ data: { mediaAssetKeys: ['media:first', 'media:second'], imageCount: 2 } });
    const reads = [];
    const api = createCameraControlNodeApi({ state, documentRef, getImageAsset: async key => { reads.push(key); return 'data:image/png;base64,original'; } });
    await api.refreshCameraControlPreview(node.id);
    assert.equal(node.data.image, 'data:image/png;base64,original');
    assert.deepEqual(reads, ['media:first']);
});

test('camera never substitutes a disabled or missing first source with its displayed later image', async () => {
    for (const source of [
        { enabled: false, imageData: 'later', data: { imageList: ['first', 'later'] } },
        { imageData: 'later', data: { imageList: ['later'], mediaAssetKeys: ['media:first', 'media:later'], mediaIntegrity: { missingItems: [{ position: 0 }] } } }
    ]) {
        const { node, state, documentRef } = fixture(source);
        const api = createCameraControlNodeApi({ state, documentRef });
        await api.refreshCameraControlPreview(node.id);
        assert.equal(node.data.image, '');
        assert.equal(node.data.cameraPreviewImage, 'saved-snapshot');
    }
});

test('late primary-image reads cannot write a same-ID node in another workflow', async () => {
    let finish;
    const { node, state, documentRef } = fixture({ data: { mediaAssetKeys: ['media:first'] } });
    const api = createCameraControlNodeApi({ state, documentRef, getActiveWorkflowId: () => state.activeWorkflowId, getImageAsset: () => new Promise(resolve => { finish = resolve; }) });
    const pending = api.refreshCameraControlPreview(node.id);
    await Promise.resolve();
    const replacement = { id: node.id, type: node.type, data: { image: 'workflow-b-image', pitch: -9 } };
    state.nodes.set(node.id, replacement); state.activeWorkflowId = 'workflow-b';
    finish?.('data:image/png;base64,workflow-a');
    await pending;
    assert.deepEqual(replacement.data, { image: 'workflow-b-image', pitch: -9 });
});

test('a source disabled during original-image recovery cannot become the camera reference', async () => {
    let finish;
    const { node, upstream, state, documentRef } = fixture({ data: { mediaAssetKeys: ['media:first'] } });
    const api = createCameraControlNodeApi({ state, documentRef,
        getImageAsset: () => new Promise(resolve => { finish = resolve; }) });
    const pending = api.refreshCameraControlPreview(node.id);
    await Promise.resolve();
    upstream.enabled = false;
    finish('recovered-disabled-image');
    await pending;
    assert.equal(node.data.image, '');
    assert.equal(node.data.cameraPreviewImage, 'saved-snapshot');
});

test('lazy editor loading is bound to the original node object and workflow and still opens the current workflow', async () => {
    let completeLoad;
    const opened = [];
    const { node, state, documentRef } = fixture();
    const api = createCameraControlNodeApi({ state, documentRef, getActiveWorkflowId: () => state.activeWorkflowId,
        loadCameraModule: () => new Promise(resolve => { completeLoad = resolve; }) });
    const pending = api.openCameraControlEditor(node.id);
    await Promise.resolve();
    assert.equal(typeof completeLoad, 'function');
    state.nodes.set(node.id, { id: node.id, type: node.type, data: {} }); state.activeWorkflowId = 'workflow-b';
    completeLoad({ createCameraControlNodeApi: () => ({ openCameraControlEditor: id => opened.push(id) }) });
    await pending;
    assert.deepEqual(opened, []);
    await api.openCameraControlEditor(node.id);
    assert.deepEqual(opened, [node.id]);
});

test('the original editor button remains usable after initial workflow identity assignment and ignores a detached node', async () => {
    const { node, state, documentRef } = fixture();
    state.activeWorkflowId = '';
    const listeners = new Map(), opened = [];
    const button = { dataset: {}, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener() {} };
    const root = { querySelector: () => button };
    const api = createCameraControlNodeApi({ state, documentRef,
        loadCameraModule: async () => ({ createCameraControlNodeApi: () => ({ openCameraControlEditor: id => opened.push(id) }) }) });
    api.setupCameraControlNode(node.id, root);
    state.activeWorkflowId = 'workflow-a';
    const event = { preventDefault() {}, stopPropagation() {} };
    listeners.get('click')(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [node.id]);
    state.nodes.set(node.id, { id: node.id, type: node.type, data: {} });
    listeners.get('click')(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [node.id]);
});

test('clone, disabled and running camera nodes cannot open the editable Three.js surface', async () => {
    for (const lock of ['clone', 'disabled', 'running']) {
        const { node, state, documentRef } = fixture();
        let loads = 0;
        if (lock === 'clone') node.isClone = true;
        if (lock === 'disabled') node.enabled = false;
        if (lock === 'running') state.runningNodeIds = new Set([node.id]);
        const api = createCameraControlNodeApi({ state, documentRef, loadCameraModule: async () => { loads++; return { createCameraControlNodeApi: () => ({ openCameraControlEditor() {} }) }; } });
        await api.openCameraControlEditor(node.id);
        assert.equal(loads, 0, lock);
    }
});

test('execution keeps derived camera text available without reviving an obsolete or missing reference', async () => {
    const { node, upstream, state, documentRef } = fixture();
    const references = [];
    const api = createExecutionCoreApi({ state, nodeConfigs: {}, documentRef, windowRef: {},
        syncCameraControlNode: async (_id, image) => references.push(image) });
    node.data.image = 'obsolete-reference';
    await api.nodeHandlers.CameraControl(node, {});
    assert.equal(node.data.image, '');
    assert.equal(references.at(-1), '');
    assert.match(node.data.text, /camera/i);
    await api.nodeHandlers.CameraControl(node, { image: [null, 'later-image'] });
    assert.equal(node.data.image, '');
    upstream.enabled = false;
    await api.nodeHandlers.CameraControl(node, { image: 'disabled-source-image' });
    assert.equal(node.data.image, '');
    assert.equal(node.data.cameraPreviewImage, 'saved-snapshot');
});
