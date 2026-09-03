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
