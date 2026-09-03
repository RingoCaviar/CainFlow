import { createHistoryPanelApi } from '../../features/history/history-panel.js';
import { createHistoryPreviewApi } from '../../features/history/history-preview.js';
import { createHistoryFullscreenApi } from '../../features/history/history-fullscreen.js';

/**
 * Creates the history feature bootstrap wiring without leaking preview/panel/fullscreen setup
 * details into the main app bootstrap.
 */
export function createHistoryFeature({
    registry,
    state,
    getHistory,
    getHistoryMetadata,
    getHistoryCount,
    getHistoryEntry,
    getHistoryImageBlob,
    createThumbnail,
    createVideoThumbnail,
    updateHistoryThumb,
    clearHistory,
    deleteHistoryEntry,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    showToast
}) {
    let historyPreviewApi = null;

    async function regenerateHistoryVideoThumbnail(id) {
        const entry = await getHistoryEntry(id);
        const video = entry?.videoBlob || entry?.video;
        if (!(video instanceof Blob)) {
            showToast('本地视频不可用，无法重新生成缩略图', 'warning');
            return false;
        }
        const thumbnail = await createVideoThumbnail(video, 256, entry.videoAssetKey || `history:${id}`);
        if (!thumbnail || !await updateHistoryThumb(id, thumbnail)) {
            showToast('重新生成视频缩略图失败', 'warning');
            return false;
        }
        await renderHistoryList();
        showToast('已重新生成视频缩略图', 'success');
        return true;
    }

    function getHistoryPanelApi() {
        if (!registry.historyPanelApi) {
            registry.historyPanelApi = createHistoryPanelApi({
                state,
                getHistory,
                getHistoryMetadata,
                getHistoryCount,
                getHistoryEntry,
                createThumbnail,
                createVideoThumbnail,
                updateHistoryThumb,
                regenerateHistoryVideoThumbnail,
                openHistoryPreview: (item) => historyPreviewApi.openHistoryPreview(item),
                deleteHistoryEntry
            });
        }
        return registry.historyPanelApi;
    }

    function getHistoryFullscreenApi() {
        if (!registry.historyFullscreenApi) {
            registry.historyFullscreenApi = createHistoryFullscreenApi({
                state,
                getHistory,
                getHistoryMetadata,
                getHistoryEntry,
                clearHistory,
                deleteHistoryEntry,
                deleteHistoryItems: (ids) => historyPreviewApi.deleteHistoryItems(ids),
                openHistoryPreview: (item) => historyPreviewApi.openHistoryPreview(item),
                downloadImage,
                createThumbnail,
                createVideoThumbnail,
                updateHistoryThumb,
                regenerateHistoryVideoThumbnail,
                showToast
            });
        }
        return registry.historyFullscreenApi;
    }

    async function renderHistoryList() {
        await getHistoryPanelApi().renderHistoryList();
        if (registry.historyFullscreenApi?.isOpen()) {
            await registry.historyFullscreenApi.refresh();
        }
    }

    function applyHistoryGridCols(cols) {
        getHistoryPanelApi().applyHistoryGridCols(cols);
    }

    historyPreviewApi = createHistoryPreviewApi({
        getHistory,
        getHistoryMetadata,
        getHistoryEntry,
        getHistoryImageBlob,
        deleteHistoryEntry,
        getImageResolution,
        downloadImage,
        copyToClipboard,
        renderHistoryList: () => renderHistoryList(),
        showToast
    });

    function initHistoryFeature() {
        historyPreviewApi.initHistoryPreview();
        getHistoryFullscreenApi().initHistoryFullscreen();
    }

    return {
        historyPreviewApi,
        getHistoryPanelApi,
        getHistoryFullscreenApi,
        renderHistoryList,
        applyHistoryGridCols,
        initHistoryFeature
    };
}
