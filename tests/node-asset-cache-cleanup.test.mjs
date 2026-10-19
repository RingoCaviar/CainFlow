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

test('node asset cache cleanup keeps current node assets and removes only recoverable cache entries', async () => {
    const { documentRef, clearButton, elements } = createDocument();
    const calls = [];
    const api = createUiControllerApi({
        state: {},
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
    const click = clearButton.click();
    const dialog = elements.get('cache-clear-node-assets-dialog');
    dialog.onclick({
        preventDefault() {},
        target: {
            closest: () => ({ getAttribute: () => 'confirm' })
        }
    });
    await click;

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
        state: {}, panelManager: {}, settingsModal: {},
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
    const click = clearButton.click();
    elements.get('cache-clear-node-assets-dialog').onclick({
        preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'confirm' }) }
    });
    await click;

    assert.equal(toasts.some(([, type]) => type === 'success'), false);
    assert.equal(toasts[0][1], 'warning');
    assert.match(toasts[0][0], /2/);
});

test('manual image import cleanup warns when legacy images remain on disk', async () => {
    const { documentRef, elements } = createDocument();
    const toasts = [];
    const api = createUiControllerApi({
        state: {}, panelManager: {}, settingsModal: {}, openDB: async () => null,
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
    const click = elements.get('btn-clear-image-import-assets').click();
    elements.get('cache-clear-image-import-assets-dialog').onclick({
        preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'confirm' }) }
    });
    await click;

    assert.equal(toasts.some(([, type]) => type === 'success'), false);
    assert.equal(toasts[0][1], 'warning');
    assert.match(toasts[0][0], /1/);
});
