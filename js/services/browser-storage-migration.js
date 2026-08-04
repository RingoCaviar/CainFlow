import { DB_NAME, STORE_ASSETS, STORE_HISTORY } from '../core/constants.js';

const DOCUMENT_KEYS = {
    nodeflow_ai_state: 'session',
    cainflow_ui_bootstrap: 'ui_bootstrap',
    cainflow_prompt_library: 'prompt_library',
    cainflow_logs_state: 'logs_state',
    cainflow_request_statistics: 'request_statistics'
};

function requestResult(request, fallback = null) {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result ?? fallback);
        request.onerror = () => resolve(fallback);
    });
}

async function openLegacyDb(indexedDbRef = indexedDB) {
    try {
        return await new Promise((resolve) => {
            const request = indexedDbRef.open(DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onupgradeneeded = () => {
                request.transaction?.abort?.();
                resolve(null);
            };
        });
    } catch {
        return null;
    }
}

async function readLegacyStores(indexedDbRef = indexedDB) {
    const db = await openLegacyDb(indexedDbRef);
    if (!db) return { assets: [], history: [] };
    try {
        const assets = [];
        if (db.objectStoreNames.contains(STORE_ASSETS)) {
            const tx = db.transaction(STORE_ASSETS, 'readonly');
            const store = tx.objectStore(STORE_ASSETS);
            const [keys, values] = await Promise.all([
                requestResult(store.getAllKeys(), []), requestResult(store.getAll(), [])
            ]);
            keys.forEach((key, index) => assets.push({ key: String(key), value: values[index] }));
        }
        const history = db.objectStoreNames.contains(STORE_HISTORY)
            ? await requestResult(db.transaction(STORE_HISTORY, 'readonly').objectStore(STORE_HISTORY).getAll(), [])
            : [];
        return { assets, history };
    } finally {
        db.close();
    }
}

function getLegacyDocuments(localStorageRef = localStorage) {
    const documents = {};
    Object.entries(DOCUMENT_KEYS).forEach(([key, name]) => {
        const raw = localStorageRef.getItem(key);
        if (raw === null) return;
        try { documents[name] = JSON.parse(raw); } catch { documents[name] = raw; }
    });
    const updateState = {};
    const networkDetection = {};
    const noticeState = {};
    for (let index = 0; index < localStorageRef.length; index += 1) {
        const key = localStorageRef.key(index);
        if (!key || DOCUMENT_KEYS[key]) continue;
        const value = localStorageRef.getItem(key);
        if (key.startsWith('cainflow_update_')) updateState[key] = value;
        else if (key.startsWith('cainflow_network_')) networkDetection[key] = value;
        else if (key.startsWith('cainflow_')) noticeState[key] = value;
    }
    if (Object.keys(updateState).length) documents.update_state = updateState;
    if (Object.keys(networkDetection).length) documents.network_detection = networkDetection;
    if (Object.keys(noticeState).length) documents.notice_state = noticeState;
    return documents;
}

function valueToBlob(value) {
    if (value instanceof Blob) return value;
    if (typeof value === 'string' && value.startsWith('data:')) {
        const comma = value.indexOf(',');
        const header = value.slice(0, comma);
        const mime = header.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
        const binary = atob(value.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: mime });
    }
    return new Blob([JSON.stringify(value)], { type: 'application/x-cainflow-image-list+json' });
}

async function uploadAsset(key, value, kind = 'migration') {
    const blob = valueToBlob(value);
    const response = await fetch(`/api/storage/assets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-CainFlow-Asset-Kind': kind },
        body: blob
    });
    if (!response.ok) throw new Error(`迁移资产 ${key} 失败`);
}

export async function scanLegacyBrowserStorage() {
    const documents = getLegacyDocuments();
    const { assets, history } = await readLegacyStores();
    const assetBytes = assets.reduce((total, item) => total + valueToBlob(item.value).size, 0);
    return { documents, assets, history, documentCount: Object.keys(documents).length, assetCount: assets.length, historyCount: history.length, assetBytes };
}

export async function migrateLegacyBrowserStorage(scan, { replace = false } = {}) {
    const start = await fetch('/api/storage/migration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: scan.documents, replace, complete: false })
    });
    if (!start.ok) throw new Error((await start.json().catch(() => ({}))).error || '无法开始迁移');

    for (const asset of scan.assets) {
        await uploadAsset(asset.key, asset.value, asset.key.startsWith('history:') ? 'history' : 'migration');
    }
    for (const original of scan.history) {
        const entry = { ...original };
        const id = Number(entry.id || Date.now() * 1000);
        let assetKey = entry.videoAssetKey || entry.imageAssetKey || `history:${id}`;
        if (entry.image && !scan.assets.some((asset) => asset.key === assetKey)) await uploadAsset(assetKey, entry.image, 'history');
        if ((entry.videoBlob || entry.video instanceof Blob) && !scan.assets.some((asset) => asset.key === assetKey)) {
            await uploadAsset(assetKey, entry.videoBlob || entry.video, 'history');
        }
        entry.id = id;
        entry.timestamp = Number(entry.timestamp || Date.now());
        entry.mediaType = entry.mediaType === 'video' || entry.videoAssetKey ? 'video' : 'image';
        entry.imageAssetKey = entry.mediaType === 'image' ? assetKey : '';
        entry.videoAssetKey = entry.mediaType === 'video' ? assetKey : '';
        if (entry.thumb) {
            const thumbKey = `thumb:history:${id}`;
            await uploadAsset(thumbKey, entry.thumb, 'thumbnail');
            entry.thumbAssetKey = thumbKey;
        }
        delete entry.image; delete entry.video; delete entry.videoBlob;
        const response = await fetch('/api/storage/history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
        });
        if (!response.ok) throw new Error(`迁移历史记录 ${id} 失败`);
    }
    const finish = await fetch('/api/storage/migration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ complete: true })
    });
    if (!finish.ok) throw new Error('迁移完成标记写入失败');
    return true;
}

export async function clearLegacyBrowserStorage() {
    localStorage.clear();
    await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
}
