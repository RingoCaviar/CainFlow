import assert from 'node:assert/strict';
import test from 'node:test';

import { saveGeneratedMediaToDirectory } from '../js/features/media/generated-media-directory-save.js';
import { createRuntimeAutoSaveToDir } from '../js/features/workflow/workflow-runtime-manager.js';

test('directory save writes a video-only ImageSave payload in order', async () => {
    const writes = [];
    const progressEvents = [];
    const directoryHandle = {
        name: 'exports',
        queryPermission: async () => 'granted',
        getFileHandle: async (filename, { create }) => {
            assert.equal(create, true);
            return {
                createWritable: async () => ({
                    write: async (blob) => writes.push({ filename, size: blob.size }),
                    close: async () => {}
                })
            };
        }
    };
    const localVideo = { id: 'video-1', url: '/api/storage/assets/media%3Avideo-1', assetKey: 'media:video-1' };
    const result = await saveGeneratedMediaToDirectory({
        payload: { videos: [localVideo] },
        directoryHandle,
        filenamePrefix: 'video',
        dataURLtoBlob: () => { throw new Error('images are not part of this scenario'); },
        downloadVideo: async (url) => {
            assert.equal(url, localVideo.url);
            return new Blob(['video bytes'], { type: 'video/mp4' });
        },
        buildImageFilenameBases: () => [],
        buildVideoFilenameBase: () => 'video_2026-09-14_01-00-00',
        detectVideoExtension: () => '.mp4',
        getAvailableFileHandle: async (handle, baseName, extension) => ({
            fileHandle: await handle.getFileHandle(`${baseName}${extension}`, { create: true }),
            filename: `${baseName}${extension}`
        }),
        onVideoProgress: (event) => progressEvents.push(event)
    });

    assert.deepEqual(result, { status: 'saved', filenames: ['video_2026-09-14_01-00-00.mp4'] });
    assert.deepEqual(writes, [{ filename: 'video_2026-09-14_01-00-00.mp4', size: 11 }]);
    assert.deepEqual(progressEvents.map(({ videoCount, total }) => ({ videoCount, total })), [
        { videoCount: 1, total: undefined },
        { videoCount: 1, total: 11 },
        { videoCount: 1, total: undefined }
    ]);
});

test('background ImageSave writes its local Media asset to the configured directory', async () => {
    const writes = [];
    const videoBytes = new Uint8Array(1024);
    videoBytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const directoryHandle = {
        name: 'exports', queryPermission: async () => 'granted',
        getFileHandle: async (filename, { create }) => {
            if (!create) {
                const error = new Error('missing');
                error.name = 'NotFoundError';
                throw error;
            }
            return { createWritable: async () => ({ write: async (blob) => writes.push({ filename, size: blob.size }), close: async () => {} }) };
        }
    };
    const runtimeState = {
        globalSaveDirHandle: directoryHandle,
        imageSaveUsePromptFilename: false,
        connections: [],
        nodes: new Map([['save', { id: 'save', type: 'ImageSave' }]])
    };
    const autoSave = createRuntimeAutoSaveToDir({
        runtimeState, runtimeDocument: { getElementById: () => null }, workflowName: 'Background',
        dataURLtoBlob: () => null,
        fetchRef: async (url) => {
            assert.equal(url, '/api/storage/assets/media%3Avideo-1');
            return new Response(videoBytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
        },
        formatProxyErrorMessage: () => '', addLog: () => {}, showToast: () => {},
        windowRef: { location: { href: 'http://localhost/' } }
    });

    await autoSave('save', { video: { url: '/api/storage/assets/media%3Avideo-1', assetKey: 'media:video-1' } });

    assert.equal(writes.length, 1);
    assert.match(writes[0].filename, /^video_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);
    assert.equal(writes[0].size, 1024);
});
