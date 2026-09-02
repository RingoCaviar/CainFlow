import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPanelApi } from '../js/features/history/history-panel.js';

function createPanelDocument() {
    const list = {
        innerHTML: '',
        replaceChildren() {},
        querySelectorAll() { return []; },
        ondragstart: null,
        ondragend: null,
        onclick: null
    };
    return {
        getElementById(id) {
            if (id === 'history-list') return list;
            return null;
        },
        querySelector() { return null; },
        list
    };
}

test('history sidebar hydrates a missing video thumbnail from the persisted video', async () => {
    const documentRef = createPanelDocument();
    let videoThumbnailCalls = 0;
    let savedThumbnail = '';
    const panel = createHistoryPanelApi({
        state: { selectedHistoryIds: new Set(), historySelectionMode: false },
        getHistoryMetadata: async () => [{
            id: 7,
            mediaType: 'video',
            hasVideo: true,
            model: 'video-model',
            timestamp: 1,
            thumb: ''
        }],
        getHistoryCount: async () => 1,
        getHistoryEntry: async () => ({ id: 7, mediaType: 'video', videoBlob: new Blob(['video']) }),
        createThumbnail: async () => {
            throw new Error('Image thumbnail generation must not receive a video');
        },
        createVideoThumbnail: async (video) => {
            videoThumbnailCalls += 1;
            assert.ok(video instanceof Blob);
            return 'data:image/webp;base64,video-thumb';
        },
        updateHistoryThumb: async (_id, thumb) => { savedThumbnail = thumb; },
        openHistoryPreview() {},
        deleteHistoryEntry: async () => {},
        documentRef,
        windowRef: {
            requestIdleCallback(callback) {
                queueMicrotask(() => callback({ timeRemaining: () => 16 }));
            }
        }
    });

    await panel.renderHistoryList();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(videoThumbnailCalls, 1);
    assert.equal(savedThumbnail, 'data:image/webp;base64,video-thumb');
});
