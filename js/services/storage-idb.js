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

export function createIndexedDbApi(getState) {
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

    async function getImageAsset(nodeId) {
        try {
            const db = await openDB();
            return await requestToPromise(db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId));
        } catch {
            return null;
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
            const entry = { ...data, thumb, timestamp: Date.now() };
            const db = await openDB();
            const tx = db.transaction(STORE_HISTORY, 'readwrite');
            tx.objectStore(STORE_HISTORY).add(entry);
            const state = getState();
            if (state.cacheSizes[STORE_HISTORY] !== null && state.cacheSizes[STORE_HISTORY] !== undefined) {
                state.cacheSizes[STORE_HISTORY] += JSON.stringify(entry).length / (1024 * 1024);
            }
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB save history failed:', error);
            return false;
        }
    }

    async function getHistory() {
        try {
            const db = await openDB();
            const result = await requestToPromise(db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).getAll());
            return (result || []).sort((a, b) => b.timestamp - a.timestamp);
        } catch {
            return [];
        }
    }

    async function clearHistory() {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_HISTORY, 'readwrite');
            tx.objectStore(STORE_HISTORY).clear();
            getState().cacheSizes[STORE_HISTORY] = 0;
            return await waitForTransaction(tx);
        } catch (error) {
            console.warn('IDB clear history failed:', error);
            return false;
        }
    }

    async function deleteHistoryEntry(id) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_HISTORY, 'readwrite');
            tx.objectStore(STORE_HISTORY).delete(id);
            getState().cacheSizes[STORE_HISTORY] = null;
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
        deleteImageAsset,
        createThumbnail,
        saveHistoryEntry,
        getHistory,
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
