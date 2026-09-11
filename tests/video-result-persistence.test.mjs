import assert from 'node:assert/strict';
import test from 'node:test';

import { getVideoResultSource, persistVideoResultForNode } from '../js/features/media/video/video-result-persistence.js';

test('downstream video source prefers the persistent Media asset identity', () => {
    assert.equal(getVideoResultSource({
        videoUrl: 'https://example.test/expiring.mp4', videoAssetKey: 'media:video-a'
    }), '/api/storage/assets/media%3Avideo-a');
    assert.equal(getVideoResultSource({
        videoUrl: 'https://example.test/fallback.mp4'
    }), 'https://example.test/fallback.mp4');
});

test('generated video becomes a persistent node media source', async () => {
    const node = { id: 'video-a', data: {}, activeMediaOperationId: 'operation-a' };
    const blobs = [
        new Blob(['first'], { type: 'video/mp4' }),
        new Blob(['second'], { type: 'video/mp4' })
    ];
    const calls = [];

    const assetKey = await persistVideoResultForNode({
        node,
        videoBlobs: blobs,
        workflowId: 'workflow-a',
        saveWorkflowNodeMediaAssets: async (...args) => {
            calls.push(args);
            return [
                { asset_key: 'media:first', mediaOperationId: 'operation-a' },
                { asset_key: 'media:second', mediaOperationId: 'operation-a' }
            ];
        },
        rememberWorkflowMediaOperation: (_node, assets) => {
            calls.push(['remember', assets]);
        }
    });

    assert.deepEqual(assetKey, ['media:first', 'media:second']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:first', 'media:second']);
    assert.equal(node.data.videoAssetKey, 'media:second');
    assert.equal(calls[0][0][0], blobs[0]);
    assert.equal(calls[0][0][1], blobs[1]);
    assert.deepEqual(calls[0].slice(1), ['workflow-a', 'video-a', 'operation-a']);
});

test('video persistence failure keeps the remote result usable', async () => {
    const node = { id: 'video-a', data: { videoUrl: 'https://example.test/video.mp4' } };

    const assetKey = await persistVideoResultForNode({
        node,
        videoBlobs: [new Blob(['video'])],
        workflowId: 'workflow-a',
        saveWorkflowNodeMediaAssets: async () => []
    });

    assert.deepEqual(assetKey, []);
    assert.equal(node.data.videoUrl, 'https://example.test/video.mp4');
    assert.equal(node.data.mediaAssetKeys, undefined);
});

test('video persistence storage error does not fail generation', async () => {
    const node = { id: 'video-a', data: { videoUrl: 'https://example.test/video.mp4' } };
    const keys = await persistVideoResultForNode({
        node,
        videoBlobs: [new Blob(['video'])],
        workflowId: 'workflow-a',
        saveWorkflowNodeMediaAssets: async () => { throw new Error('disk full'); }
    });

    assert.deepEqual(keys, []);
    assert.equal(node.data.videoUrl, 'https://example.test/video.mp4');
});
