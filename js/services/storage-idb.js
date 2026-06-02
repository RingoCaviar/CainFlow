/**
 * 封装 IndexedDB 的打开、读写与资源管理能力，用于图片资产、历史记录和句柄缓存持久化。
 */
import {
    DB_NAME,
    DB_VERSION,
    STORE_ASSETS,
    STORE_HANDLES,
    STORE_HISTORY
} from '../core/constants.js';

let dbInstance = null;
const HISTORY_ASSET_KEY_PREFIX = 'history:';
const IMAGE_IMPORT_ASSET_KEY_PREFIX = 'image-import:';

function getHistoryAssetKey(id) {
    return `${HISTORY_ASSET_KEY_PREFIX}${id}`;
}

function isImageImportAssetKey(key) {
    return typeof key === 'string' && key.startsWith(IMAGE_IMPORT_ASSET_KEY_PREFIX);
}

function getImageImportAssetKey(nodeId, preferredKey = '') {
    if (isImageImportAssetKey(preferredKey)) return preferredKey;
    return `${IMAGE_IMPORT_ASSET_KEY_PREFIX}${String(nodeId || '').trim()}`;
}

function createHistoryEntryId() {
    const base = Date.now() * 1000;
    const offset = Math.floor(Math.random() * 1000);
    return base + offset;
}

function stripHistoryImage(entry) {
    if (!entry) return entry;
    const { image, video, videoBlob, ...metadata } = entry;
    return metadata;
}

function dataUrlToBlob(dataUrl) {
    const source = String(dataUrl || '').trim();
    if (!source.startsWith('data:')) return null;
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) return null;

    const header = source.slice(0, commaIndex);
    const payload = source.slice(commaIndex + 1);
    const mimeMatch = header.match(/^data:([^;]+)(;base64)?/i);
    const mimeType = mimeMatch?.[1] || 'application/octet-stream';
    const isBase64 = /;base64/i.test(header);

    try {
        if (isBase64) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return new Blob([bytes], { type: mimeType });
        }

        return new Blob([decodeURIComponent(payload)], { type: mimeType });
    } catch {
        return null;
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve) => {
        if (!(blob instanceof Blob)) {
            resolve('');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
    });
}

function prepareHistoryAssetValue(image) {
    return dataUrlToBlob(image) || image;
}

function prepareVideoAssetValue(video) {
    if (video instanceof Blob) return video;
    if (video?.blob instanceof Blob) return video.blob;
    if (video?.videoBlob instanceof Blob) return video.videoBlob;
    if (typeof video === 'string' && video.startsWith('data:')) return dataUrlToBlob(video) || video;
    return video || null;
}

function formatVideoObjectUrl(blob) {
    return URL.createObjectURL(blob);
}

function createMediaPlaceholderThumbnail(label = 'IMG', size = 256) {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        const gradient = ctx.createLinearGradient(0, 0, size, size);
        gradient.addColorStop(0, '#111827');
        gradient.addColorStop(0.55, '#2563eb');
        gradient.addColorStop(1, '#22d3ee');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        ctx.font = `800 ${Math.round(size * 0.16)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, size / 2, size / 2);
        return canvas.toDataURL('image/webp', 0.82);
    } catch {
        return '';
    }
}

export function createIndexedDbApi(getState) {
    const pendingHistoryMigrations = new Set();
    let historyMigrationRunning = false;

    async function openDB() {
        if (dbInstance) return dbInstance;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
                if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
                if (!db.objectStoreNames.contains(STORE_HISTORY)) {
                    db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => {
                dbInstance = req.result;
                resolve(dbInstance);
            };
            req.onerror = () => reject(req.error);
        });
    }

    async function saveHandle(key, handle) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_HANDLES, 'readwrite');
            tx.objectStore(STORE_HANDLES).put(handle, key);
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save handle failed:', error);
            return false;
        }
    }

    async function getHandle(key) {
        try {
            const db = await openDB();
            return await requestToPromise(db.transaction(STORE_HANDLES).objectStore(STORE_HANDLES).get(key));
        } catch {
            return null;
        }
    }

    async function deleteHandle(key) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_HANDLES, 'readwrite');
            tx.objectStore(STORE_HANDLES).delete(key);
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB delete handle failed:', error);
            return false;
        }
    }

    async function saveImageAsset(nodeId, dataUrl) {
        if (!dataUrl || dataUrl.length < 100) return false;
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            tx.objectStore(STORE_ASSETS).put(dataUrl, nodeId);
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save asset failed:', error);
            return false;
        }
    }

    async function saveImageAssetList(nodeId, images) {
        const imageList = Array.isArray(images)
            ? images.filter((item) => typeof item === 'string' && item.trim())
            : [];
        if (imageList.length === 0) return false;
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            tx.objectStore(STORE_ASSETS).put({
                type: 'image-list',
                images: imageList
            }, nodeId);
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save asset list failed:', error);
            return false;
        }
    }

    async function saveImageImportAsset(nodeId, dataUrl, preferredKey = '') {
        if (!dataUrl || dataUrl.length < 100) return '';
        const key = getImageImportAssetKey(nodeId, preferredKey);
        if (!key || key === IMAGE_IMPORT_ASSET_KEY_PREFIX) return '';
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            tx.objectStore(STORE_ASSETS).put(dataUrl, key);
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx) ? key : '';
        } catch (error) {
            console.warn('IDB save image import asset failed:', error);
            return '';
        }
    }

    async function getImageAsset(nodeId) {
        try {
            const db = await openDB();
            const asset = await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId));
            if (asset instanceof Blob) {
                return await blobToDataUrl(asset);
            }
            return typeof asset === 'string' ? asset : null;
        } catch {
            return null;
        }
    }

    async function getImageAssetBlob(nodeId) {
        try {
            const db = await openDB();
            const asset = await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId));
            if (asset instanceof Blob) return asset;
            if (typeof asset === 'string') return dataUrlToBlob(asset);
            return null;
        } catch {
            return null;
        }
    }

    async function getHistoryImageBlob(id) {
        try {
            const normalizedId = Number(id);
            if (!Number.isFinite(normalizedId)) return null;
            const db = await openDB();
            const entry = await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).get(normalizedId));
            if (!entry || entry.mediaType === 'video' || entry.videoAssetKey) return null;

            const imageAssetKey = entry.imageAssetKey || getHistoryAssetKey(normalizedId);
            const asset = imageAssetKey
                ? await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(imageAssetKey))
                : null;
            if (asset instanceof Blob) return asset;
            if (typeof asset === 'string') return dataUrlToBlob(asset);
            if (entry.image) return dataUrlToBlob(entry.image);
            return null;
        } catch {
            return null;
        }
    }

    async function getImageAssetList(nodeId) {
        try {
            const db = await openDB();
            const asset = await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId));
            if (Array.isArray(asset)) {
                return asset.filter((item) => typeof item === 'string' && item.trim());
            }
            if (asset && typeof asset === 'object' && asset.type === 'image-list' && Array.isArray(asset.images)) {
                return asset.images.filter((item) => typeof item === 'string' && item.trim());
            }
            if (asset instanceof Blob) {
                const dataUrl = await blobToDataUrl(asset);
                return dataUrl ? [dataUrl] : [];
            }
            return typeof asset === 'string' && asset.trim() ? [asset] : [];
        } catch (error) {
            console.warn('IDB get image asset list failed:', error);
            return [];
        }
    }

    async function deleteImageAsset(nodeId) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            tx.objectStore(STORE_ASSETS).delete(nodeId);
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch {
            return false;
        }
    }

    function createThumbnail(dataUrl, size = 256) {
        return new Promise((resolve) => {
            const source = typeof dataUrl === 'string' ? dataUrl.trim() : '';
            let settled = false;
            let timer = null;
            const fallbackThumb = () => createMediaPlaceholderThumbnail('IMG', size);
            const finish = (thumb) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(thumb || fallbackThumb());
            };
            if (!source) {
                finish('');
                return;
            }
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        finish(fallbackThumb());
                        return;
                    }

                    let sx = 0;
                    let sy = 0;
                    let sw = img.width;
                    let sh = img.height;

                    if (sw > sh) {
                        sx = (sw - sh) / 2;
                        sw = sh;
                    } else if (sh > sw) {
                        sy = (sh - sw) / 2;
                        sh = sw;
                    }

                    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
                    finish(canvas.toDataURL('image/webp', 0.8));
                } catch (error) {
                    console.warn('Create history thumbnail failed, using placeholder fallback:', error);
                    finish(fallbackThumb());
                }
            };
            img.onerror = () => finish(fallbackThumb());
            img.src = source;
            timer = setTimeout(() => finish(fallbackThumb()), 5000);
        });
    }

    async function deleteImageImportAsset(assetKeyOrNodeId) {
        const raw = String(assetKeyOrNodeId || '').trim();
        const key = isImageImportAssetKey(raw) ? raw : getImageImportAssetKey(raw);
        if (!key || key === IMAGE_IMPORT_ASSET_KEY_PREFIX) return false;
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            tx.objectStore(STORE_ASSETS).delete(key);
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch {
            return false;
        }
    }

    async function clearImageImportAssets() {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            const store = tx.objectStore(STORE_ASSETS);
            const req = store.openKeyCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                if (isImageImportAssetKey(cursor.key)) store.delete(cursor.key);
                cursor.continue();
            };
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB clear image import assets failed:', error);
            return false;
        }
    }

    async function clearOrphanedImageImportAssets(activeAssetKeys = []) {
        try {
            const keepKeys = new Set(
                Array.from(activeAssetKeys || [])
                    .map((key) => String(key || '').trim())
                    .filter(isImageImportAssetKey)
            );
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            const store = tx.objectStore(STORE_ASSETS);
            let deletedCount = 0;
            const req = store.openKeyCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                const key = cursor.key;
                if (isImageImportAssetKey(key) && !keepKeys.has(key)) {
                    store.delete(key);
                    deletedCount += 1;
                }
                cursor.continue();
            };
            const ok = await waitForTransaction(tx);
            if (ok && deletedCount > 0) getState().cacheSizes[STORE_ASSETS] = null;
            return ok;
        } catch (error) {
            console.warn('IDB clear orphaned image import assets failed:', error);
            return false;
        }
    }

    function createVideoPlaceholderThumbnail(size = 256) {
        return createMediaPlaceholderThumbnail('VIDEO', size);
    }

    function createVideoThumbnail(videoSource, size = 256) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            let objectUrl = '';
            let settled = false;

            const cleanup = () => {
                video.pause();
                video.removeAttribute('src');
                video.load();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            };

            const finish = (thumb = '') => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(thumb);
            };

            const draw = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    const vw = video.videoWidth || size;
                    const vh = video.videoHeight || size;
                    let sx = 0;
                    let sy = 0;
                    let sw = vw;
                    let sh = vh;

                    if (sw > sh) {
                        sx = (sw - sh) / 2;
                        sw = sh;
                    } else if (sh > sw) {
                        sy = (sh - sw) / 2;
                        sh = sw;
                    }

                    ctx.fillStyle = '#111827';
                    ctx.fillRect(0, 0, size, size);
                    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, size, size);
                    finish(canvas.toDataURL('image/webp', 0.8));
                } catch {
                    finish(createVideoPlaceholderThumbnail(size));
                }
            };

            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.crossOrigin = 'anonymous';
            video.onerror = () => finish(createVideoPlaceholderThumbnail(size));
            video.onloadeddata = () => {
                try {
                    const duration = Number(video.duration);
                    if (Number.isFinite(duration) && duration > 1) {
                        video.currentTime = Math.min(1, Math.max(0, duration * 0.05));
                    } else {
                        draw();
                    }
                } catch {
                    draw();
                }
            };
            video.onseeked = draw;

            if (videoSource instanceof Blob) {
                objectUrl = formatVideoObjectUrl(videoSource);
                video.src = objectUrl;
            } else {
                video.src = String(videoSource || '');
            }

            window.setTimeout(() => finish(createVideoPlaceholderThumbnail(size)), 5000);
        });
    }

    async function saveHistoryEntry(data) {
        try {
            const mediaType = data?.mediaType === 'video' || data?.video || data?.videoBlob ? 'video' : 'image';
            const id = createHistoryEntryId();
            const mediaAssetKey = getHistoryAssetKey(id);
            const imageAsset = mediaType === 'image' ? prepareHistoryAssetValue(data.image) : null;
            if (mediaType === 'image' && !imageAsset) {
                throw new Error('Image history entry requires image data');
            }
            const videoAsset = mediaType === 'video' ? prepareVideoAssetValue(data.videoBlob || data.video) : null;
            if (mediaType === 'video' && !(videoAsset instanceof Blob)) {
                throw new Error('Video history entry requires a cached video Blob');
            }
            const videoSizeBytes = mediaType === 'video'
                ? Number(data.videoSizeBytes || videoAsset?.size || 0) || 0
                : 0;
            const thumb = mediaType === 'video'
                ? (data.thumb || await createVideoThumbnail(videoAsset || data.videoUrl || data.video, 256) || createVideoPlaceholderThumbnail(256))
                : await createThumbnail(data.image, 256);
            const entry = stripHistoryImage({
                ...data,
                id,
                mediaType,
                thumb,
                timestamp: Date.now(),
                imageAssetKey: mediaType === 'image' ? mediaAssetKey : '',
                videoAssetKey: mediaType === 'video' ? mediaAssetKey : '',
                videoUrl: mediaType === 'video' ? String(data.videoUrl || data.url || '') : '',
                videoMimeType: mediaType === 'video' ? String(data.videoMimeType || videoAsset?.type || 'video/mp4') : '',
                videoSizeBytes
            });
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            const historyStore = tx.objectStore(STORE_HISTORY);
            const assetStore = tx.objectStore(STORE_ASSETS);
            historyStore.put(entry);
            assetStore.put(mediaType === 'video' ? videoAsset : imageAsset, mediaAssetKey);
            const state = getState();
            state.cacheSizes[STORE_HISTORY] = null;
            state.cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save history failed:', {
                name: error?.name || '',
                message: error?.message || String(error),
                imageLength: typeof data?.image === 'string' ? data.image.length : 0,
                videoSize: data?.videoBlob?.size || data?.video?.size || 0
            });
            return false;
        }
    }

    async function clearImageAssets({ preserveHistory = true } = {}) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            const store = tx.objectStore(STORE_ASSETS);

            if (!preserveHistory) {
                store.clear();
            } else {
                const req = store.openKeyCursor();
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    const isHistoryAsset = typeof cursor.key === 'string' && cursor.key.startsWith(HISTORY_ASSET_KEY_PREFIX);
                    if (!isHistoryAsset && !isImageImportAssetKey(cursor.key)) store.delete(cursor.key);
                    cursor.continue();
                };
            }

            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch {
            return false;
        }
    }

    async function clearOrphanedHistoryAssets() {
        try {
            const db = await openDB();
            const historyEntries = await requestToPromise(db.transaction(STORE_HISTORY, 'readonly').objectStore(STORE_HISTORY).getAll());
            const validHistoryAssetKeys = new Set(
                (historyEntries || [])
                    .map((entry) => entry?.imageAssetKey || entry?.videoAssetKey || (entry?.id !== undefined ? getHistoryAssetKey(entry.id) : ''))
                    .filter((key) => typeof key === 'string' && key.startsWith(HISTORY_ASSET_KEY_PREFIX))
            );

            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            const store = tx.objectStore(STORE_ASSETS);
            const req = store.openKeyCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                const key = cursor.key;
                if (
                    typeof key === 'string' &&
                    key.startsWith(HISTORY_ASSET_KEY_PREFIX) &&
                    !validHistoryAssetKeys.has(key)
                ) {
                    store.delete(key);
                }
                cursor.continue();
            };

            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB clear orphaned history assets failed:', error);
            return false;
        }
    }

    async function clearOrphanedNodeAssets(activeNodeIds = []) {
        try {
            const keepNodeIds = new Set(
                Array.from(activeNodeIds || [])
                    .map((id) => String(id || '').trim())
                    .filter(Boolean)
            );
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            const store = tx.objectStore(STORE_ASSETS);
            const req = store.openKeyCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                const key = cursor.key;
                const isHistoryAsset = typeof key === 'string' && key.startsWith(HISTORY_ASSET_KEY_PREFIX);
                if (!isHistoryAsset && !isImageImportAssetKey(key) && !keepNodeIds.has(String(key))) {
                    store.delete(key);
                }
                cursor.continue();
            };

            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB clear orphaned node assets failed:', error);
            return false;
        }
    }

    function toHistoryMetadata(entry) {
        if (!entry) return null;
        if (entry.image && !entry.imageAssetKey && entry.id !== undefined) {
            scheduleHistoryAssetMigration(entry);
        }
        const mediaType = entry.mediaType === 'video' || entry.videoAssetKey ? 'video' : 'image';
        return {
            id: entry.id,
            mediaType,
            thumb: entry.thumb || '',
            prompt: entry.prompt || '',
            model: entry.model || '',
            timestamp: entry.timestamp || 0,
            generationDurationSeconds: entry.generationDurationSeconds ?? entry.generationDuration ?? null,
            imageAssetKey: entry.imageAssetKey || (entry.id !== undefined ? getHistoryAssetKey(entry.id) : ''),
            videoAssetKey: entry.videoAssetKey || '',
            videoUrl: entry.videoUrl || '',
            videoMimeType: entry.videoMimeType || '',
            videoSizeBytes: Number(entry.videoSizeBytes || 0) || 0,
            hasImage: mediaType === 'image' && Boolean(entry.image || entry.imageAssetKey),
            hasVideo: mediaType === 'video' && Boolean(entry.videoAssetKey || entry.videoUrl)
        };
    }

    function scheduleHistoryAssetMigration(entry) {
        if (!entry?.id || !entry.image || entry.imageAssetKey || pendingHistoryMigrations.has(entry.id)) return;
        pendingHistoryMigrations.add(entry.id);
        if (!historyMigrationRunning) {
            historyMigrationRunning = true;
            setTimeout(processNextHistoryMigration, 0);
        }
    }

    async function processNextHistoryMigration() {
        const next = pendingHistoryMigrations.values().next();
        if (next.done) {
            historyMigrationRunning = false;
            return;
        }

        const id = next.value;
        pendingHistoryMigrations.delete(id);

        try {
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            const historyStore = tx.objectStore(STORE_HISTORY);
            const assetStore = tx.objectStore(STORE_ASSETS);
            const req = historyStore.get(id);
            req.onsuccess = () => {
                const entry = req.result;
                if (!entry?.image || entry.imageAssetKey) return;
                const imageAssetKey = getHistoryAssetKey(id);
                assetStore.put(prepareHistoryAssetValue(entry.image), imageAssetKey);
                historyStore.put({
                    ...stripHistoryImage(entry),
                    imageAssetKey
                });
            };
            await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB migrate history image failed:', error);
        } finally {
            setTimeout(processNextHistoryMigration, 16);
        }
    }

    async function hydrateHistoryEntry(entry) {
        if (!entry) return null;
        if (entry.mediaType === 'video' || entry.videoAssetKey) {
            const videoAssetKey = entry.videoAssetKey || getHistoryAssetKey(entry.id);
            const video = await getVideoAsset(videoAssetKey);
            return {
                ...entry,
                mediaType: 'video',
                video,
                videoBlob: video instanceof Blob ? video : null,
                videoSizeBytes: Number(entry.videoSizeBytes || video?.size || 0) || 0,
                videoMimeType: entry.videoMimeType || video?.type || ''
            };
        }
        if (entry.image) {
            if (!entry.imageAssetKey && entry.id !== undefined) scheduleHistoryAssetMigration(entry);
            return entry;
        }
        const imageAssetKey = entry.imageAssetKey || getHistoryAssetKey(entry.id);
        const image = await getImageAsset(imageAssetKey);
        return { ...entry, image: image || '' };
    }

    async function getVideoAsset(nodeId) {
        try {
            const db = await openDB();
            const asset = await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId));
            return asset instanceof Blob ? asset : null;
        } catch {
            return null;
        }
    }

    async function getHistory() {
        try {
            const db = await openDB();
            const result = await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).getAll());
            const sorted = (result || []).sort((a, b) => b.timestamp - a.timestamp);
            return await Promise.all(sorted.map((entry) => hydrateHistoryEntry(entry)));
        } catch (error) {
            console.warn('IDB get history failed:', error);
            return [];
        }
    }

    async function getHistoryMetadata(options = {}) {
        try {
            const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : Infinity;
            if (limit === 0) return [];
            const direction = options.newestFirst === false ? 'next' : 'prev';
            const db = await openDB();
            const tx = db.transaction(STORE_HISTORY, 'readonly');
            const store = tx.objectStore(STORE_HISTORY);
            const items = [];

            await new Promise((resolve) => {
                const req = store.openCursor(null, direction);
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }

                    const metadata = toHistoryMetadata(cursor.value);
                    if (metadata) items.push(metadata);
                    if (items.length >= limit) {
                        resolve();
                        return;
                    }
                    cursor.continue();
                };
                req.onerror = () => resolve();
            });

            return options.preserveCursorOrder
                ? items
                : items.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        } catch (error) {
            console.warn('IDB get history metadata failed:', error);
            return [];
        }
    }

    async function getHistoryCount() {
        try {
            const db = await openDB();
            return await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).count()) || 0;
        } catch {
            return 0;
        }
    }

    async function getHistoryEntry(id) {
        try {
            const normalizedId = Number(id);
            if (!Number.isFinite(normalizedId)) return null;
            const db = await openDB();
            const entry = await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).get(normalizedId));
            return await hydrateHistoryEntry(entry);
        } catch {
            return null;
        }
    }

    async function updateHistoryThumb(id, thumb, knownEntry = null) {
        if (!thumb) return false;
        try {
            const normalizedId = Number(id);
            if (!Number.isFinite(normalizedId)) return false;
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            const store = tx.objectStore(STORE_HISTORY);
            const assetStore = tx.objectStore(STORE_ASSETS);
            const putWithThumb = (entry) => {
                if (!entry) return;
                const next = { ...entry, thumb };
                if (next.image && !next.imageAssetKey) {
                    const imageAssetKey = getHistoryAssetKey(normalizedId);
                    assetStore.put(prepareHistoryAssetValue(next.image), imageAssetKey);
                    store.put({ ...stripHistoryImage(next), imageAssetKey });
                    return;
                }
                store.put(next.image ? stripHistoryImage(next) : next);
            };
            if (knownEntry) {
                putWithThumb(knownEntry);
            } else {
                const req = store.get(normalizedId);
                req.onsuccess = () => {
                    putWithThumb(req.result);
                };
            }
            getState().cacheSizes[STORE_HISTORY] = null;
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB update history thumbnail failed:', error);
            return false;
        }
    }

    async function clearHistory() {
        try {
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            tx.objectStore(STORE_HISTORY).clear();
            const assetStore = tx.objectStore(STORE_ASSETS);
            const req = assetStore.openKeyCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                if (typeof cursor.key === 'string' && cursor.key.startsWith(HISTORY_ASSET_KEY_PREFIX)) {
                    assetStore.delete(cursor.key);
                }
                cursor.continue();
            };
            getState().cacheSizes[STORE_HISTORY] = 0;
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB clear history failed:', error);
            return false;
        }
    }

    async function deleteHistoryEntry(id) {
        try {
            const normalizedId = Number(id);
            if (!Number.isFinite(normalizedId)) return false;
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            tx.objectStore(STORE_HISTORY).delete(normalizedId);
            tx.objectStore(STORE_ASSETS).delete(getHistoryAssetKey(normalizedId));
            getState().cacheSizes[STORE_HISTORY] = null;
            getState().cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB delete history failed:', error);
            return false;
        }
    }

    return {
        openDB,
        saveHandle,
        getHandle,
        deleteHandle,
        saveImageAsset,
        getImageAsset,
        getImageAssetBlob,
        saveImageAssetList,
        getImageAssetList,
        saveImageImportAsset,
        deleteImageAsset,
        deleteImageImportAsset,
        clearImageImportAssets,
        clearOrphanedImageImportAssets,
        clearImageAssets,
        clearOrphanedHistoryAssets,
        clearOrphanedNodeAssets,
        createThumbnail,
        createVideoThumbnail,
        saveHistoryEntry,
        getHistory,
        getHistoryMetadata,
        getHistoryCount,
        getHistoryEntry,
        getHistoryImageBlob,
        updateHistoryThumb,
        clearHistory,
        deleteHistoryEntry
    };
}

function waitForTransaction(tx) {
    return new Promise((resolve) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
    });
}

function requestToPromise(request) {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}
/**
 * 封装 IndexedDB 读写逻辑，用于图片资产和历史记录持久化。
 */
