import test from 'node:test';
import assert from 'node:assert/strict';
import {
    projectMissingMediaAssets,
    renderMissingMediaPlaceholders,
    resetMissingMediaNotifications
} from '../js/features/media/missing-media-integrity.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import {
    getWorkflowCardStateLabel,
    workflowHasMissingMedia
} from '../js/features/workflow/workflow-manager.js';

test('partial Media asset damage preserves identities and positions while present entries remain usable', async () => {
    resetMissingMediaNotifications();
    const node = { id: 'node-a', data: { mediaAssetKeys: ['media:first', 'media:missing', 'media:third'] } };
    const notices = [];
    const items = await projectMissingMediaAssets({
        workflowId: 'workflow-a', node, assetKeys: node.data.mediaAssetKeys,
        loadAsset: async (key) => key === 'media:missing' ? null : `data:${key}`,
        notify: (...args) => notices.push(args)
    });

    assert.deepEqual(node.data.mediaAssetKeys, ['media:first', 'media:missing', 'media:third']);
    assert.deepEqual(items.map((item) => item.missing), [false, true, false]);
    assert.deepEqual(items.filter((item) => !item.missing).map((item) => item.value), ['data:media:first', 'data:media:third']);
    assert.equal(node.data.mediaIntegrity.missingItems[0].position, 1);
    assert.equal(node.data.mediaIntegrity.missingItems[0].workflowId, 'workflow-a');
    assert.equal(node.data.mediaIntegrity.missingItems[0].ownerType, 'workflow-node');
    assert.equal(node.isFailed, undefined);
    assert.equal(notices.length, 1);
});

test('missing-set notification appears only on first discovery or when the set changes', async () => {
    resetMissingMediaNotifications();
    const node = { id: 'node-a', data: {} };
    const notices = [];
    const run = (keys) => projectMissingMediaAssets({
        workflowId: 'workflow-a', node, assetKeys: keys,
        loadAsset: async () => null, notify: (message) => notices.push(message)
    });
    await run(['media:a']);
    await run(['media:a']);
    await run(['media:a', 'media:b']);
    assert.equal(notices.length, 2);
});

test('integrity projection never mutates the durable ordered reference list during report refresh', async () => {
    const keys = ['media:a', 'media:a', 'media:missing'];
    const node = { id: 'node-a', data: { mediaAssetKeys: keys.slice() } };
    await projectMissingMediaAssets({ workflowId: 'wf', node, assetKeys: keys, loadAsset: async () => null });
    assert.deepEqual(node.data.mediaAssetKeys, keys);
});

test('single and repeated Media asset identities survive continued saves with integrity evidence', async () => {
    const mediaIntegrity = {
        state: 'missing', mediaType: 'image', ownerType: 'workflow-node', itemCount: 3,
        missingItems: [{ position: 1, assetKey: 'media:missing', workflowId: 'wf', nodeId: 'node-a' }]
    };
    const node = {
        id: 'node-a', type: 'ImageGenerate', x: 0, y: 0, enabled: true,
        data: { mediaAssetKeys: ['media:first', 'media:missing', 'media:first'], mediaIntegrity }
    };
    const state = { nodes: new Map([[node.id, node]]), connections: [] };
    const serializer = createNodeSerializer({
        state,
        documentRef: { getElementById: () => null, querySelectorAll: () => [] }
    });

    const firstSave = serializer.serializeNodes()[0];
    const secondSave = serializer.serializeNodes()[0];
    assert.deepEqual(firstSave.mediaAssetKeys, ['media:first', 'media:missing', 'media:first']);
    assert.deepEqual(secondSave.mediaAssetKeys, firstSave.mediaAssetKeys);
    assert.deepEqual(firstSave.mediaIntegrity, mediaIntegrity);
    assert.notEqual(firstSave.mediaIntegrity, mediaIntegrity);
});

test('each missing position renders a placeholder with its original list index', () => {
    const children = [];
    const container = {
        querySelectorAll: () => [],
        querySelector: () => null,
        appendChild: (element) => children.push(element)
    };
    const documentRef = { createElement: () => ({
        className: '', dataset: {}, textContent: '',
        style: { setProperty(name, value) { this[name] = value; } }
    }) };
    const node = { data: { mediaIntegrity: { missingItems: [
        { position: 0, mediaType: 'image', redactedSource: 'media:first' },
        { position: 2, mediaType: 'image', redactedSource: 'media:third' }
    ] } } };

    renderMissingMediaPlaceholders(node, container, documentRef);
    assert.deepEqual(children.map((item) => item.dataset.position), ['0', '2']);
    assert.deepEqual(children.map((item) => item.style['--missing-media-position']), ['0', '2']);
    assert.deepEqual(children.map((item) => item.hidden), [false, true]);
    assert.ok(children.every((item) => item.className === 'missing-media-asset-placeholder'));
});

test('integrity metadata contains owner, media type, position and redacted source without execution failure', async () => {
    const longKey = `media:${'sensitive'.repeat(8)}`;
    const node = { id: 'node-a', data: {} };
    await projectMissingMediaAssets({
        workflowId: 'workflow-a', node, assetKeys: [longKey], mediaType: 'image', loadAsset: async () => null
    });
    const missing = node.data.mediaIntegrity.missingItems[0];
    assert.deepEqual(
        [missing.workflowId, missing.nodeId, missing.ownerType, missing.ownerId, missing.mediaType, missing.position],
        ['workflow-a', 'node-a', 'workflow-node', 'workflow-a:node-a', 'image', 0]
    );
    assert.notEqual(missing.redactedSource, longKey);
    assert.equal(node.isFailed, undefined);
});

test('workflow cards retain a missing-media state without reporting an execution error', () => {
    const tab = { data: { nodes: [{ id: 'node-a', mediaIntegrity: { state: 'missing' } }] } };
    assert.equal(workflowHasMissingMedia(tab), true);
    assert.equal(getWorkflowCardStateLabel({ isActive: true, isOpen: true, missingMedia: true }), '媒体缺失');
    assert.equal(getWorkflowCardStateLabel({ isOpen: true, runResult: 'error', missingMedia: true }), '失败');
});

test('asset read errors remain errors instead of being persisted as missing media', async () => {
    const node = { id: 'node-a', data: {} };
    await assert.rejects(projectMissingMediaAssets({
        workflowId: 'workflow-a', node, assetKeys: ['media:unknown'],
        loadAsset: async () => { throw new Error('storage unavailable'); }
    }), /storage unavailable/);
    assert.equal(node.data.mediaIntegrity, undefined);
});

test('integrity changes refresh workflow presentation only when the missing set changes', async () => {
    const node = { id: 'node-a', data: {} };
    let refreshes = 0;
    const project = (keys) => projectMissingMediaAssets({
        workflowId: 'workflow-a', node, assetKeys: keys, loadAsset: async () => null,
        onIntegrityChange: () => { refreshes += 1; }
    });
    await project(['media:first']);
    await project(['media:first']);
    await project(['media:first', 'media:second']);
    assert.equal(refreshes, 2);
});
