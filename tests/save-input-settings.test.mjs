import test from 'node:test';
import assert from 'node:assert/strict';
import { readImageSaveFilename } from '../js/nodes/image-save-settings.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { resolveUniversalInput, getUniversalInputRoles } from '../js/nodes/universal-input-policy.js';

test('Save filenames use their own live editor or retained state, including an empty draft', () => {
    const node = { id: 'save', type: 'ImageSave', data: { filename: 'workflow-a' } };
    assert.equal(readImageSaveFilename(node), 'workflow-a');
    assert.equal(readImageSaveFilename({ id: 'legacy', type: 'ImageSave' }, ''), '', 'callers retain their established image/video defaults when no draft exists');
    node.parameterRoot = { querySelector: () => ({ value: 'edited' }) };
    assert.equal(readImageSaveFilename(node), 'edited');
    node.parameterRoot = { querySelector: () => ({ value: '' }) };
    assert.equal(readImageSaveFilename(node), '');
    delete node.parameterRoot;
    const [saved] = createNodeSerializer({ state: { nodes: new Map([[node.id, node]]), connections: [], canvas: {} },
        documentRef: { getElementById: () => null, querySelectorAll: () => [] } }).serializeNodes();
    assert.equal(saved.filename, 'workflow-a');
});

test('Save routes each actual image or video output to its own single role and keeps both outputs discoverable', () => {
    const targetNode = { id: 'target', type: 'ImageSave', data: {} };
    const sourceNode = { id: 'source', type: 'ImageSave', data: { imageList: ['one', 'two'], videos: [{ assetKey: 'media:v1' }, { assetKey: 'media:v2' }] } };
    const state = { nodes: new Map([[targetNode.id, targetNode], [sourceNode.id, sourceNode]]), connections: [] };
    const args = { state, targetNode, sourceNode };
    assert.deepEqual(getUniversalInputRoles(targetNode).map(role => role[0]), ['image', 'video']);
    assert.equal(resolveUniversalInput({ ...args, sourcePort: 'image' }).port, 'image');
    assert.equal(resolveUniversalInput({ ...args, sourcePort: 'video' }).port, 'video');
    state.connections.push({ id: 'image', from: { nodeId: 'other', port: 'image' }, to: { nodeId: 'target', port: 'image' }, type: 'image' });
    assert.match(resolveUniversalInput({ ...args, sourcePort: 'image' }).error, /占用/);
    assert.equal(resolveUniversalInput({ ...args, sourcePort: 'video' }).error, '');
    state.connections.push({ id: 'video', from: { nodeId: 'other', port: 'video' }, to: { nodeId: 'target', port: 'video' }, type: 'video' });
    assert.match(resolveUniversalInput({ ...args, sourcePort: 'video' }).error, /占用/);
    assert.equal(resolveUniversalInput({ ...args, sourcePort: 'video', role: 'video', ignoreConnectionId: 'video' }).error, '');
    assert.match(resolveUniversalInput({ ...args, sourcePort: 'video', role: 'image' }).error, /不兼容/);
    assert.deepEqual(sourceNode.data.imageList, ['one', 'two']);
    assert.equal(sourceNode.data.videos.length, 2);
});
