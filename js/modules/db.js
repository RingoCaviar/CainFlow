/**
 * CainFlow — Database & Persistence
 * IndexedDB operations for handles, assets, and history.
 */

import { 
    DB_NAME, DB_VERSION, STORE_HANDLES, STORE_ASSETS, STORE_HISTORY 
} from './constants.js';

import { createThumbnail } from './utils.js';
import { state } from './state.js';

let _dbInstance = null;

export async function openDB() {
    if (_dbInstance) return _dbInstance;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
            if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
            if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => {
            _dbInstance = req.result;
            resolve(_dbInstance);
        };
        req.onerror = () => reject(req.error);
    });
}

// ===== Handles =====

export async function saveHandle(key, handle) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HANDLES, 'readwrite');
        tx.objectStore(STORE_HANDLES).put(handle, key);
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save handle failed:', e); }
}

export async function getHandle(key) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_HANDLES).objectStore(STORE_HANDLES).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

// ===== Assets =====

export async function saveImageAsset(nodeId, dataUrl) {
    if (!dataUrl || dataUrl.length < 100) return;
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).put(dataUrl, nodeId);
        // Invalidate cache since we don't know if we overwrote or added
        state.cacheSizes[STORE_ASSETS] = null;
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save asset failed:', e); }
}

export async function getImageAsset(nodeId) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

export async function deleteImageAsset(nodeId) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).delete(nodeId);
        state.cacheSizes[STORE_ASSETS] = null; 
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { return false; }
}

export async function clearAssets() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).clear();
        state.cacheSizes[STORE_ASSETS] = 0;
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB clear assets failed:', e); }
}

// ===== History =====

export async function saveHistoryEntry(data) {
    try {
        const thumb = await createThumbnail(data.image, 256);
        const entry = { ...data, thumb, timestamp: Date.now() };
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).add(entry);
        
        // Incremental update if cache exists
        if (state.cacheSizes[STORE_HISTORY] !== null && state.cacheSizes[STORE_HISTORY] !== undefined) {
            const sizeBytes = JSON.stringify(entry).length;
            state.cacheSizes[STORE_HISTORY] += (sizeBytes / (1024 * 1024));
        }
        
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save history failed:', e); }
}

export async function getHistory() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).getAll();
            req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
            req.onerror = () => resolve([]);
        });
    } catch (e) { return []; }
}

export async function clearHistory() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).clear();
        state.cacheSizes[STORE_HISTORY] = 0;
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB clear history failed:', e); }
}

export async function deleteHistoryEntry(id) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).delete(id);
        state.cacheSizes[STORE_HISTORY] = null; // Invalidate
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB delete history failed:', e); }
}

// ===== Storage Utilities =====

export async function getStoreSizeMB(storeName) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            let bytes = 0;
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const val = cursor.value;
                    if (typeof val === 'string') bytes += val.length;
                    else bytes += JSON.stringify(val).length;
                    cursor.continue();
                } else {
                    resolve((bytes / (1024 * 1024)).toFixed(2));
                }
            };
            req.onerror = () => resolve("0.00");
        });
    } catch (e) { return "0.00"; }
}

export function getLocalStorageMB() {
    let bytes = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            bytes += (key.length + val.length) * 2; // UTF-16
        }
    } catch (e) {}
    return (bytes / (1024 * 1024)).toFixed(2);
}
