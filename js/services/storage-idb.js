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

function getHistoryAssetKey(id) {
    return `${HISTORY_ASSET_KEY_PREFIX}${id}`;
}

function createHistoryEntryId() {
    const base = Date.now() * 1000;
    const offset = Math.floor(Math.random() * 1000);
    return base + offset;
}

function stripHistoryImage(entry) {
    if (!entry) return entry;
    const { image, ...metadata } = entry;
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
        } catch {
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
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');

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
                resolve(canvas.toDataURL('image/webp', 0.8));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    async function saveHistoryEntry(data) {
        try {
            const thumb = await createThumbnail(data.image, 256);
            const id = createHistoryEntryId();
            const imageAssetKey = getHistoryAssetKey(id);
            const entry = stripHistoryImage({
                ...data,
                id,
                thumb,
                timestamp: Date.now(),
                imageAssetKey
            });
            const db = await openDB();
            const tx = db.transaction([STORE_HISTORY, STORE_ASSETS], 'readwrite');
            const historyStore = tx.objectStore(STORE_HISTORY);
            const assetStore = tx.objectStore(STORE_ASSETS);
            historyStore.put(entry);
            assetStore.put(prepareHistoryAssetValue(data.image), imageAssetKey);
            const state = getState();
            state.cacheSizes[STORE_HISTORY] = null;
            state.cacheSizes[STORE_ASSETS] = null;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save history failed:', {
                name: error?.name || '',
                message: error?.message || String(error),
                imageLength: typeof data?.image === 'string' ? data.image.length : 0
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
                    if (!isHistoryAsset) store.delete(cursor.key);
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
                    .map((entry) => entry?.imageAssetKey || (entry?.id !== undefined ? getHistoryAssetKey(entry.id) : ''))
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

    function toHistoryMetadata(entry) {
        if (!entry) return null;
        if (entry.image && !entry.imageAssetKey && entry.id !== undefined) {
            scheduleHistoryAssetMigration(entry);
        }
        return {
            id: entry.id,
            thumb: entry.thumb || '',
            prompt: entry.prompt || '',
            model: entry.model || '',
            timestamp: entry.timestamp || 0,
            generationDurationSeconds: entry.generationDurationSeconds ?? entry.generationDuration ?? null,
            imageAssetKey: entry.imageAssetKey || (entry.id !== undefined ? getHistoryAssetKey(entry.id) : ''),
            hasImage: Boolean(entry.image || entry.imageAssetKey)
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
        if (entry.image) {
            if (!entry.imageAssetKey && entry.id !== undefined) scheduleHistoryAssetMigration(entry);
            return entry;
        }
        const imageAssetKey = entry.imageAssetKey || getHistoryAssetKey(entry.id);
        const image = await getImageAsset(imageAssetKey);
        return { ...entry, image: image || '' };
    }

    async function getHistory() {
        try {
            const db = await openDB();
            const result = await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).getAll());
            const sorted = (result || []).sort((a, b) => b.timestamp - a.timestamp);
            return await Promise.all(sorted.map((entry) => hydrateHistoryEntry(entry)));
        } catch {
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
        } catch {
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
        saveImageAsset,
        getImageAsset,
        saveImageAssetList,
        getImageAssetList,
        deleteImageAsset,
        clearImageAssets,
        clearOrphanedHistoryAssets,
        createThumbnail,
        saveHistoryEntry,
        getHistory,
        getHistoryMetadata,
        getHistoryCount,
        getHistoryEntry,
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
