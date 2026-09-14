const HISTORY_ASSET_KEY_PREFIX = 'history:';
const IMAGE_IMPORT_ASSET_KEY_PREFIX = 'image-import:';
const IMAGE_LIST_MIME = 'application/x-cainflow-image-list+json';

function assetUrl(key) {
    return `/api/storage/assets/${encodeURIComponent(String(key))}`;
}

function dataUrlToBlob(dataUrl) {
    const source = String(dataUrl || '');
    const comma = source.indexOf(',');
    if (!source.startsWith('data:') || comma < 0) return null;
    const header = source.slice(0, comma);
    const mime = header.match(/^data:([^;,]+)/i)?.[1] || 'application/octet-stream';
    const payload = source.slice(comma + 1);
    try {
        if (/;base64/i.test(header)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
        return null;
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve) => {
        if (!(blob instanceof Blob)) return resolve('');
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

async function putAsset(key, value, kind = 'asset') {
    let blob = value instanceof Blob ? value : dataUrlToBlob(value);
    if (!blob && value && typeof value === 'object') {
        blob = new Blob([JSON.stringify(value)], { type: IMAGE_LIST_MIME });
    }
    if (!blob || blob.size === 0) return false;
    const response = await fetch(assetUrl(key), {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-CainFlow-Asset-Kind': kind },
        body: blob
    });
    return response.ok;
}

function workflowOperationOwnerId(workflowId, nodeId, operationId) {
    return JSON.stringify([String(workflowId).trim(), String(nodeId).trim(), String(operationId)]);
}

function normalizeOrCreateWorkflowMediaOperationId(value) {
    const operationId = String(value || '').trim();
    return operationId || globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function putMediaAsset(value, ownerType, ownerId) {
    const blob = value instanceof Blob ? value : dataUrlToBlob(value);
    if (!blob || blob.size === 0 || !ownerType || !ownerId) return null;
    const response = await fetch('/api/storage/media-assets', {
        method: 'PUT',
        headers: {
            'Content-Type': blob.type || 'application/octet-stream',
            'X-CainFlow-Media-Owner-Type': String(ownerType),
            'X-CainFlow-Media-Owner-Id': String(ownerId)
        },
        body: blob
    });
    if (!response.ok) return null;
    return (await response.json()).asset || null;
}

async function referenceMediaAsset(ownerType, ownerId, assetKey) {
    const response = await fetch('/api/storage/media-assets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reference', ownerType, ownerId, assetKey })
    });
    return response.ok;
}

async function removeMediaReference(ownerType, ownerId, assetKey) {
    const response = await fetch('/api/storage/media-assets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unreference', ownerType, ownerId, assetKey })
    });
    return response.ok;
}

async function postMediaAssetAction(action, extra = {}) {
    const response = await fetch('/api/storage/media-assets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra })
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    delete payload.success;
    return payload;
}

async function getAssetBlob(key) {
    try {
        const response = await fetch(assetUrl(key), { cache: 'no-store' });
        return response.ok ? await response.blob() : null;
    } catch {
        return null;
    }
}

async function postMaintenance(action, extra = {}) {
    const response = await fetch('/api/storage/maintenance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra })
    });
    return response.ok;
}

function createThumbnail(dataUrl, size = 256) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const context = canvas.getContext('2d');
            const side = Math.min(image.width, image.height);
            context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
            resolve(canvas.toDataURL('image/webp', 0.8));
        };
        image.onerror = () => resolve('');
        image.src = dataUrl;
    });
}

function getStableVideoThumbnailPosition(seed) {
    let hash = 2166136261;
    for (const char of String(seed || 'video-thumbnail')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return 0.1 + ((hash >>> 0) / 0xffffffff) * 0.8;
}

function isNearBlackVideoFrame(context, size) {
    try {
        const pixels = context.getImageData(0, 0, size, size).data;
        for (let index = 0; index < pixels.length; index += 16) {
            if (pixels[index] > 12 || pixels[index + 1] > 12 || pixels[index + 2] > 12) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function createVideoThumbnail(videoSource, size = 256, seed = '') {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        let objectUrl = '';
        let finished = false;
        let seekingFrame = false;
        let capturePoints = [];
        let captureIndex = 0;
        let renderedFrameTimeout = null;
        const timeout = setTimeout(() => finish(''), 8000);
        const finish = (value = '') => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            clearTimeout(renderedFrameTimeout);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            resolve(value);
        };
        const captureFrame = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const context = canvas.getContext('2d');
                context.drawImage(video, 0, 0, size, size);
                if (isNearBlackVideoFrame(context, size)) {
                    captureNextFrame();
                    return;
                }
                const thumbnail = canvas.toDataURL('image/webp', 0.8);
                if (thumbnail) finish(thumbnail);
                else captureNextFrame();
            } catch { captureNextFrame(); }
        };
        const captureNextFrame = () => {
            const captureAt = capturePoints[captureIndex++];
            if (!Number.isFinite(captureAt)) {
                finish('');
                return;
            }
            try {
                seekingFrame = true;
                video.currentTime = captureAt;
            } catch { captureNextFrame(); }
        };
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onloadedmetadata = () => {
            const duration = Number(video.duration);
            if (!Number.isFinite(duration) || duration <= 0) {
                captureFrame();
                return;
            }
            try {
                const primaryPosition = getStableVideoThumbnailPosition(seed);
                const alternatePosition = 0.1 + ((primaryPosition - 0.1 + 0.4) % 0.8);
                capturePoints = [duration * primaryPosition, duration * alternatePosition];
                captureNextFrame();
            } catch { captureFrame(); }
        };
        video.onseeked = () => {
            if (typeof video.requestVideoFrameCallback === 'function') {
                const captureRenderedFrame = () => {
                    clearTimeout(renderedFrameTimeout);
                    captureFrame();
                };
                video.requestVideoFrameCallback(captureRenderedFrame);
                // A paused video can dispatch `seeked` without scheduling a
                // compositor frame. Do not leave history hydration waiting
                // for the overall timeout in that case.
                renderedFrameTimeout = setTimeout(captureRenderedFrame, 100);
            } else {
                captureFrame();
            }
        };
        video.onloadeddata = () => { if (!seekingFrame) captureFrame(); };
        video.onerror = () => finish('');
        if (videoSource instanceof Blob) {
            objectUrl = URL.createObjectURL(videoSource);
            video.src = objectUrl;
        } else video.src = String(videoSource || '');
    });
}

export function createDiskStorageApi(getState) {
    const pendingMediaCancellationsKey = 'cainflow_pending_media_operation_cancellations';
    function readPendingMediaCancellations() {
        try {
            const value = JSON.parse(globalThis.localStorage?.getItem?.(pendingMediaCancellationsKey) || '[]');
            return Array.isArray(value) ? value.filter((ownerId) => typeof ownerId === 'string' && ownerId) : [];
        } catch { return []; }
    }
    function writePendingMediaCancellations(ownerIds) {
        try {
            globalThis.localStorage?.setItem?.(pendingMediaCancellationsKey, JSON.stringify([...new Set(ownerIds)]));
        } catch { /* The caller still receives failure and can retry while this session remains alive. */ }
    }
    async function flushPendingMediaCancellations(additionalOwnerIds = []) {
        const failed = [];
        for (const ownerId of [...new Set([...readPendingMediaCancellations(), ...additionalOwnerIds])]) {
            try {
                const result = await postMediaAssetAction('cancel-operation-owner', { ownerId });
                if (result?.cancelled !== true) failed.push(ownerId);
            } catch { failed.push(ownerId); }
        }
        writePendingMediaCancellations(failed);
        return failed.length === 0;
    }
    function createBackendDirectoryHandle(directory) {
        return {
            kind: 'directory',
            name: directory,
            directory,
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
            async getFileHandle(filename, options = {}) {
                if (options.create === false) throw new DOMException('File lookup is handled by the backend', 'NotFoundError');
                return {
                    name: filename,
                    async createWritable() {
                        const chunks = [];
                        return {
                            async write(value) { chunks.push(value instanceof Blob ? value : new Blob([value])); },
                            async close() {
                                const blob = new Blob(chunks);
                                const response = await fetch('/api/storage/export-media', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': blob.type || 'application/octet-stream',
                                        'X-CainFlow-Filename': filename
                                    },
                                    body: blob
                                });
                                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '保存文件失败');
                            }
                        };
                    }
                };
            }
        };
    }
    async function getHandle(key) {
        if (key !== 'GLOBAL_SAVE_DIR') return null;
        const response = await fetch('/api/storage/export-directory', { cache: 'no-store' });
        if (!response.ok) return null;
        const directory = (await response.json()).directory || '';
        return directory ? createBackendDirectoryHandle(directory) : null;
    }
    async function saveHandle(key, value) {
        if (key !== 'GLOBAL_SAVE_DIR') return false;
        const directory = typeof value === 'string' ? value : value?.directory || value?.name || '';
        const response = await fetch('/api/storage/export-directory', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory })
        });
        return response.ok;
    }
    async function deleteHandle(key) { return key === 'GLOBAL_SAVE_DIR' ? saveHandle(key, '') : true; }
    async function saveWorkflowNodeMediaAsset(value, workflowId, nodeId, requestedOperationId = '') {
        const operationId = normalizeOrCreateWorkflowMediaOperationId(requestedOperationId);
        const ownerId = workflowOperationOwnerId(workflowId || '', nodeId || '', operationId);
        if (!workflowId || !nodeId) return null;
        const result = await postMediaAssetAction('materialize-owner-list', {
            ownerType: 'workflow-operation', ownerId, values: [value]
        });
        const asset = Array.isArray(result?.assets) && result.assets.length === 1 ? result.assets[0] : null;
        return asset ? { ...asset, mediaOperationId: operationId, mediaTemporaryOwnerId: ownerId } : null;
    }
    async function saveWorkflowNodeMediaAssets(values, workflowId, nodeId, operationId = '') {
        const items = Array.isArray(values) ? values.filter(Boolean) : [];
        const stableOperationId = normalizeOrCreateWorkflowMediaOperationId(operationId);
        if (!workflowId || !nodeId || items.length === 0) return [];
        const ownerId = workflowOperationOwnerId(workflowId, nodeId, stableOperationId);
        const result = await postMediaAssetAction('materialize-owner-list', {
            ownerType: 'workflow-operation', ownerId, values: items
        });
        return Array.isArray(result?.assets) && result.assets.length === items.length
            ? result.assets.map((asset) => ({ ...asset, mediaOperationId: stableOperationId, mediaTemporaryOwnerId: ownerId }))
            : [];
    }
    async function releaseWorkflowNodeMediaAssets(keys, workflowId, nodeId) {
        const ownerId = `${String(workflowId || '').trim()}:${String(nodeId || '').trim()}`;
        if (!workflowId || !nodeId) return false;
        const results = await Promise.all((Array.isArray(keys) ? keys : []).filter(Boolean)
            .map((item) => item?.mediaTemporaryOwnerId
                ? removeMediaReference('workflow-operation', item.mediaTemporaryOwnerId, item.asset_key)
                : removeMediaReference('workflow-node', ownerId, item)));
        return results.every(Boolean);
    }
    async function cancelWorkflowNodeMediaOperation(workflowId, nodeId, operationId) {
        if (!workflowId || !nodeId || !operationId) return false;
        const ownerId = workflowOperationOwnerId(workflowId, nodeId, operationId);
        writePendingMediaCancellations([...readPendingMediaCancellations(), ownerId]);
        return flushPendingMediaCancellations([ownerId]);
    }
    async function releaseWorkflowMediaAssets(workflowId) {
        if (!workflowId) return false;
        return postMaintenance('release-workflow-media', { workflowId });
    }
    async function getStorageSafetyStatus() {
        const response = await fetch('/api/storage/safety-status', { cache: 'no-store' });
        return response.ok ? (await response.json()).safety || null : null;
    }
    async function getMediaOwnerReferenceList(workflowId, ownerType, ownerId) {
        const query = new URLSearchParams({ workflowId, ownerType, ownerId });
        const response = await fetch(`/api/storage/media-owner?${query}`, { cache: 'no-store' });
        return response.ok ? (await response.json()).owner || null : null;
    }
    async function listMediaOwnerReferenceLists(workflowId) {
        const query = new URLSearchParams({ workflowId });
        const response = await fetch(`/api/storage/media-owners?${query}`, { cache: 'no-store' });
        return response.ok ? (await response.json()).owners || [] : null;
    }
    async function recordMediaWorkflowRevision(workflowId, documentRevision, storageEpoch, ownerReferenceLists) {
        const result = await postMediaAssetAction('record-workflow-revision', {
            workflowId, documentRevision, storageEpoch, ownerReferenceLists
        });
        return result?.documentRevision === documentRevision;
    }
    async function replaceMediaOwnerReferenceList(request) {
        return postMediaAssetAction('replace-owner-reference-list', request);
    }
    async function saveWorkflowImportMediaAsset(value, workflowId, nodeId, operationId = '') {
        const stableOperationId = normalizeOrCreateWorkflowMediaOperationId(operationId);
        const ownerId = workflowOperationOwnerId(workflowId || '', nodeId || '', stableOperationId);
        if (!workflowId || !nodeId) return null;
        const asset = await putMediaAsset(value, 'workflow-operation', ownerId);
        return asset ? { ...asset, mediaOperationId: stableOperationId, mediaTemporaryOwnerId: ownerId } : null;
    }
    async function getImageAsset(key) { return blobToDataUrl(await getAssetBlob(key)); }
    async function getImageAssetBlob(key) { return getAssetBlob(key); }
    async function getImageAssetList(key) {
        const blob = await getAssetBlob(key);
        if (!blob) return [];
        if (blob.type === IMAGE_LIST_MIME) {
            try { return (JSON.parse(await blob.text()).images || []).filter(Boolean); } catch { return []; }
        }
        const value = await blobToDataUrl(blob);
        return value ? [value] : [];
    }
    async function deleteImageAsset(key) {
        return (await fetch(assetUrl(key), { method: 'DELETE' })).ok;
    }
    async function saveHistoryEntry(data) {
        try {
            const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
            const mediaType = data?.mediaType === 'video' || data?.videoBlob || data?.video instanceof Blob ? 'video' : 'image';
            const media = mediaType === 'video' ? (data.videoBlob || data.video) : data.image;
            const mediaBlob = media instanceof Blob ? media : dataUrlToBlob(media);
            if (!mediaBlob) return false;
            const createsHistoryReference = !data?.mediaAssetKey;
            const mediaAsset = data?.mediaAssetKey
                ? { asset_key: data.mediaAssetKey }
                : await putMediaAsset(mediaBlob, 'history', String(id));
            const mediaKey = mediaAsset?.asset_key || '';
            if (!mediaKey) return false;
            const thumb = data.thumb || (mediaType === 'video' ? await createVideoThumbnail(mediaBlob, 256, mediaKey) : await createThumbnail(data.image));
            const thumbKey = `thumb:${mediaKey}`;
            // A full cache may reject the optional thumbnail. Preserve the original
            // history entry without introducing a reference to a failed upload.
            const thumbnailSaved = thumb ? await putAsset(thumbKey, thumb, 'thumbnail') : false;
            const entry = {
                ...data, id, timestamp: Date.now(), mediaType, thumbAssetKey: thumbnailSaved ? thumbKey : '',
                imageAssetKey: mediaType === 'image' ? mediaKey : '',
                videoAssetKey: mediaType === 'video' ? mediaKey : '',
                videoMimeType: mediaType === 'video' ? mediaBlob.type : '',
                videoSizeBytes: mediaType === 'video' ? mediaBlob.size : 0
            };
            delete entry.image; delete entry.video; delete entry.videoBlob; delete entry.thumb;
            const response = await fetch('/api/storage/history', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
            });
            if (!response.ok) {
                if (createsHistoryReference) await removeMediaReference('history', String(id), mediaKey);
                return false;
            }
            data.mediaAssetKey = mediaKey;
            return { success: true, assetKey: mediaKey };
        } catch (error) {
            console.warn('Disk history save failed:', error);
            return false;
        }
    }
    async function getHistoryMetadata(options = {}) {
        const limit = Number.isFinite(options.limit) ? options.limit : 0;
        const response = await fetch(`/api/storage/history?limit=${Math.max(0, limit || 0)}`, { cache: 'no-store' });
        if (!response.ok) return [];
        const items = (await response.json()).items || [];
        return options.includeThumbs === false ? items.map(({ thumb, ...item }) => item) : items;
    }
    async function hydrateHistory(entry) {
        if (!entry) return null;
        const key = entry.videoAssetKey || entry.imageAssetKey;
        const blob = await getAssetBlob(key);
        if (entry.mediaType === 'video') return { ...entry, video: blob, videoBlob: blob };
        return { ...entry, image: await blobToDataUrl(blob) };
    }
    async function getHistory() { return Promise.all((await getHistoryMetadata()).map(hydrateHistory)); }
    async function getHistoryCount() {
        const response = await fetch('/api/storage/maintenance', { cache: 'no-store' });
        return response.ok ? Number((await response.json()).history || 0) : 0;
    }
    async function getHistoryEntry(id) {
        const response = await fetch(`/api/storage/history/${encodeURIComponent(id)}`, { cache: 'no-store' });
        return response.ok ? hydrateHistory((await response.json()).item) : null;
    }
    async function updateHistoryThumb(id, thumb) {
        const entry = await getHistoryEntry(id);
        if (!entry || !thumb) return false;
        const thumbKey = `thumb:${HISTORY_ASSET_KEY_PREFIX}${id}`;
        if (!await putAsset(thumbKey, thumb, 'thumbnail')) return false;
        const payload = { ...entry, thumbAssetKey: thumbKey };
        delete payload.image; delete payload.video; delete payload.videoBlob; delete payload.thumb;
        return (await fetch('/api/storage/history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        })).ok;
    }
    async function deleteHistoryEntry(id) { return (await fetch(`/api/storage/history/${id}`, { method: 'DELETE' })).ok; }
    async function getHistoryImageBlob(id) {
        const entry = await getHistoryEntry(id);
        return entry?.mediaType === 'image' ? dataUrlToBlob(entry.image) : null;
    }
    void flushPendingMediaCancellations();
    return {
        openDB: async () => ({ diskBacked: true }), saveHandle, getHandle, deleteHandle,
        getImageAsset, getImageAssetBlob, getImageAssetList,
        saveWorkflowNodeMediaAsset,
        saveWorkflowNodeMediaAssets,
        cancelWorkflowNodeMediaOperation,
        releaseWorkflowNodeMediaAssets,
        releaseWorkflowMediaAssets,
        getStorageSafetyStatus,
        getMediaOwnerReferenceList,
        listMediaOwnerReferenceLists,
        recordMediaWorkflowRevision,
        replaceMediaOwnerReferenceList,
        saveWorkflowImportMediaAsset,
        putMediaAsset, referenceMediaAsset, removeMediaReference,
        deleteImageAsset, deleteImageImportAsset: deleteImageAsset,
        clearImageImportAssets: () => postMaintenance('clear-assets', { mode: 'image-import' }),
        clearOrphanedImageImportAssets: () => postMaintenance('clear-assets', { mode: 'image-import-orphans' }),
        clearImageAssets: ({ preserveHistory = true } = {}) => postMaintenance('clear-assets', { mode: preserveHistory ? 'nodes' : 'all' }),
        clearOrphanedHistoryAssets: () => postMaintenance('clear-assets', { mode: 'orphans' }),
        clearOrphanedNodeAssets: () => postMaintenance('clear-assets', { mode: 'node-orphans' }),
        trimHistoryCache: () => postMaintenance('trim-history'), createThumbnail, createVideoThumbnail,
        saveHistoryEntry, getHistory, getHistoryMetadata, getHistoryCount, getHistoryEntry, getHistoryImageBlob,
        updateHistoryThumb, clearHistory: () => postMaintenance('clear-history'), deleteHistoryEntry
    };
}
