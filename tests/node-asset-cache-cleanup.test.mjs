import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiControllerApi } from '../js/features/ui/ui-controller.js';

function createElement() {
    const listeners = new Map();
    const classes = new Set();
    return {
        id: '',
        innerHTML: '',
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name)
        },
        addEventListener(type, listener) { listeners.set(type, listener); },
        async click() { return listeners.get('click')?.({ preventDefault() {} }); },
        querySelector() { return null; }
    };
}

function createDocument() {
    const elements = new Map();
    const documentRef = {
        getElementById: (id) => elements.get(id) || null,
        createElement: () => createElement(),
        body: { appendChild(element) { elements.set(element.id, element); } }
    };
    const clearButton = createElement();
    elements.set('btn-clear-assets', clearButton);
    elements.set('btn-clear-image-import-assets', createElement());
    elements.set('btn-toggle-cache', createElement());
    elements.set('cache-sidebar', createElement());
    return { documentRef, clearButton, elements };
}

function mockHealthyStorageFetch() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url === '/api/storage/safety-status') return new Response(JSON.stringify({
            safety: { state: 'healthy' }
        }), { status: 200 });
        if (url === '/api/storage/integrity-report') return new Response('', { status: 404 });
        throw new Error(`Unexpected request: ${url}`);
    };
    return () => { globalThis.fetch = originalFetch; };
}

test('node asset cache cleanup keeps current node assets and removes only recoverable cache entries', async () => {
    const { documentRef, clearButton, elements } = createDocument();
    const calls = [];
    const api = createUiControllerApi({
        state: { nodes: new Map() },
        panelManager: {},
        settingsModal: {},
        openDB: async () => { throw new Error('IndexedDB fallback must not run'); },
        clearHistory: async () => true,
        clearImageAssets: async () => { calls.push('clear-all-node-assets'); return true; },
        clearOrphanedNodeAssets: async (keys) => { calls.push(['clear-orphans', [...keys]]); return true; },
        collectRetainedNodeAssetIds: () => new Set(['active-node', 'active-asset']),
        refreshRecoverableMediaNodes: async () => { calls.push('refresh-recoverable-nodes'); },
        getHistory: async () => [],
        renderHistoryList: () => {},
        renderLogs: () => {},
        historyPreviewApi: {},
        historyFullscreenApi: {},
        settingsControllerApi: { updateCacheUsage: () => calls.push('update-usage') },
        applyHistoryGridCols: () => {},
        saveState: () => {},
        showToast: () => {},
        copyToClipboard: () => {},
        downloadImage: () => {},
        initFeatureModules: () => {},
        documentRef,
        localStorageRef: {},
        indexedDbRef: {},
        locationRef: { reload() {} },
        confirmRef: () => true,
        alertRef: () => {}
    });

    api.initCache();
    const restoreFetch = mockHealthyStorageFetch();
    try {
        const click = clearButton.click();
        const dialog = elements.get('cache-clear-node-assets-dialog');
        dialog.onclick({
            preventDefault() {},
            target: {
                closest: () => ({ getAttribute: () => 'confirm' })
            }
        });
        await click;
    } finally { restoreFetch(); }

    assert.deepEqual(calls, [
        'refresh-recoverable-nodes',
        ['clear-orphans', ['active-node', 'active-asset']],
        'update-usage'
    ]);
});

test('manual node cleanup warns when media reclamation retains candidates', async () => {
    const { documentRef, clearButton, elements } = createDocument();
    const toasts = [];
    const api = createUiControllerApi({
        state: { nodes: new Map() }, panelManager: {}, settingsModal: {},
        openDB: async () => { throw new Error('unexpected IndexedDB fallback'); },
        clearHistory: async () => true,
        clearOrphanedNodeAssets: async () => ({
            success: true, assetsDeleted: 0, orphanFilesDeleted: 0,
            gcSuspended: true, candidatesRetained: 2
        }),
        collectRetainedNodeAssetIds: () => new Set(),
        refreshRecoverableMediaNodes: async () => {},
        getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
        historyPreviewApi: {}, historyFullscreenApi: {},
        settingsControllerApi: { updateCacheUsage: () => {} },
        applyHistoryGridCols: () => {}, saveState: () => {},
        showToast: (...args) => toasts.push(args), copyToClipboard: () => {},
        downloadImage: () => {}, initFeatureModules: () => {},
        documentRef, localStorageRef: {}, indexedDbRef: {},
        locationRef: { reload() {} }, confirmRef: () => true, alertRef: () => {}
    });
    api.initCache();
    const restoreFetch = mockHealthyStorageFetch();
    try {
        const click = clearButton.click();
        elements.get('cache-clear-node-assets-dialog').onclick({
            preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'confirm' }) }
        });
        await click;
    } finally { restoreFetch(); }

    assert.equal(toasts.some(([, type]) => type === 'success'), false);
    assert.equal(toasts[0][1], 'warning');
    assert.match(toasts[0][0], /2/);
});

test('manual image import cleanup warns when legacy images remain on disk', async () => {
    const { documentRef, elements } = createDocument();
    const toasts = [];
    const api = createUiControllerApi({
        state: { nodes: new Map() }, panelManager: {}, settingsModal: {}, openDB: async () => null,
        clearHistory: async () => true,
        clearImageImportAssets: async () => ({
            success: true, assetsDeleted: 0, gcSuspended: true, candidatesRetained: 1
        }),
        getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
        historyPreviewApi: {}, historyFullscreenApi: {},
        settingsControllerApi: { updateCacheUsage: () => {} },
        applyHistoryGridCols: () => {}, saveState: () => {},
        showToast: (...args) => toasts.push(args), copyToClipboard: () => {},
        downloadImage: () => {}, initFeatureModules: () => {},
        documentRef, localStorageRef: {}, indexedDbRef: {},
        locationRef: { reload() {} }, confirmRef: () => true, alertRef: () => {}
    });
    api.initCache();
    const restoreFetch = mockHealthyStorageFetch();
    try {
        const click = elements.get('btn-clear-image-import-assets').click();
        elements.get('cache-clear-image-import-assets-dialog').onclick({
            preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'confirm' }) }
        });
        await click;
    } finally { restoreFetch(); }

    assert.equal(toasts.some(([, type]) => type === 'success'), false);
    assert.equal(toasts[0][1], 'warning');
    assert.match(toasts[0][0], /1/);
});

test('history cleanup warns when collection retains registered media', async () => {
    const { documentRef, elements } = createDocument();
    elements.set('btn-clear-cache', createElement());
    const toasts = [];
    const api = createUiControllerApi({
        state: { nodes: new Map() }, panelManager: {}, settingsModal: {},
        openDB: async () => null,
        clearHistory: async () => ({ success: true, historyDeleted: 2,
            assetsDeleted: 0, candidatesRetained: 1, gcSuspended: false }),
        getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
        historyPreviewApi: {}, historyFullscreenApi: {},
        settingsControllerApi: { updateCacheUsage: async () => {} },
        applyHistoryGridCols: () => {}, saveState: () => {},
        showToast: (...args) => toasts.push(args), copyToClipboard: () => {},
        downloadImage: () => {}, initFeatureModules: () => {},
        documentRef, localStorageRef: {}, indexedDbRef: {},
        locationRef: { reload() {} }, confirmRef: () => true, alertRef: () => {}
    });
    api.initCache();
    const restoreFetch = mockHealthyStorageFetch();
    try {
        const click = elements.get('btn-clear-cache').click();
        elements.get('cache-clear-history-dialog').onclick({
            preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'confirm' }) }
        });
        await click;
    } finally { restoreFetch(); }
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'warning');
    assert.match(toasts[0][0], /1 项媒体/);
});

test('manual temporary cleanup reports partial filesystem and browser cache failures', async () => {
    const { documentRef, elements } = createDocument();
    const clearButton = createElement();
    elements.set('btn-clear-temporary-cache', clearButton);
    documentRef.defaultView = { caches: { keys: async () => ['cache'], delete: async () => false } };
    const originalFetch = globalThis.fetch;
    const toasts = [];
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'POST') return new Response(JSON.stringify({
            success: true, temporaryDeleted: 0, orphanFilesDeleted: 0,
            temporaryFailed: 1, orphanFilesFailed: 1, gcSuspended: false
        }), { status: 200 });
        if (url === '/api/storage/safety-status') return new Response(JSON.stringify({
            safety: { state: 'healthy' }
        }), { status: 200 });
        return new Response('', { status: 404 });
    };
    try {
        const api = createUiControllerApi({
            state: { nodes: new Map() }, panelManager: {}, settingsModal: {},
            openDB: async () => null, clearHistory: async () => true,
            getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
            historyPreviewApi: {}, historyFullscreenApi: {},
            settingsControllerApi: { updateCacheUsage: async () => {} },
            applyHistoryGridCols: () => {}, saveState: () => {},
            showToast: (...args) => toasts.push(args), copyToClipboard: () => {},
            downloadImage: () => {}, initFeatureModules: () => {},
            documentRef, localStorageRef: {}, indexedDbRef: {},
            locationRef: { reload() {} }, confirmRef: () => true, alertRef: () => {}
        });
        api.initCache();
        await clearButton.click();
        assert.equal(toasts[0][1], 'warning');
        assert.match(toasts[0][0], /2 个文件或目录处理失败/);
        assert.match(toasts[0][0], /浏览器缓存删除失败/);
        assert.equal(toasts.some(([, type]) => type === 'success'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('one temporary cleanup click scans first, retries after a safety scan, then refreshes usage', async () => {
    const { documentRef, elements } = createDocument();
    elements.get('cache-sidebar').classList.add('active');
    elements.set('btn-clear-temporary-cache', createElement());
    documentRef.defaultView = { caches: { keys: async () => [], delete: async () => true } };
    const originalFetch = globalThis.fetch;
    const calls = [];
    const toasts = [];
    let safetyState = 'gc_suspended';
    let safetyReason = 'unclean_shutdown';
    let clears = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/storage/safety-status') return new Response(JSON.stringify({
            safety: { state: safetyState, reason: safetyReason }
        }), { status: 200 });
        if (url === '/api/storage/integrity-report') return new Response('', { status: 404 });
        if (url === '/api/storage/maintenance' && options.method === 'POST') {
            const { action } = JSON.parse(options.body);
            calls.push(action);
            if (action === 'scan-media-integrity') {
                safetyState = 'healthy';
                safetyReason = 'integrity_scan_complete';
                return new Response(JSON.stringify({ complete: true }), { status: 200 });
            }
            clears += 1;
            if (clears === 1) {
                safetyState = 'scan_required';
                safetyReason = 'unregistered_files_removed';
                return new Response(JSON.stringify({ temporaryDeleted: 1, orphanFilesDeleted: 1,
                    gcSuspended: true, candidatesRetained: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify({ assetsDeleted: 1, gcSuspended: false,
                candidatesRetained: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    try {
        const api = createUiControllerApi({
            state: { nodes: new Map() }, panelManager: {}, settingsModal: {},
            openDB: async () => null, clearHistory: async () => true,
            getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
            historyPreviewApi: {}, historyFullscreenApi: {},
            settingsControllerApi: { updateCacheUsage: async () => { calls.push('usage'); } },
            applyHistoryGridCols: () => {}, saveState: () => {},
            showToast: (...args) => toasts.push(args), copyToClipboard: () => {},
            downloadImage: () => {}, initFeatureModules: () => {},
            documentRef, localStorageRef: {}, indexedDbRef: {},
            locationRef: { reload() {} }, confirmRef: () => true, alertRef: () => {}
        });
        api.initCache();
        await elements.get('btn-clear-temporary-cache').click();
        assert.deepEqual(calls, [
            'scan-media-integrity', 'clear-temporary', 'scan-media-integrity',
            'clear-temporary', 'usage'
        ]);
        assert.equal(toasts.at(-1)[1], 'success');
        assert.match(toasts.at(-1)[0], /3 个文件/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
