import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiControllerApi } from '../js/features/ui/ui-controller.js';

function createElement({ checked = true } = {}) {
    const listeners = new Map();
    const classes = new Set(['hidden']);
    return {
        checked,
        value: '',
        textContent: '',
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
            contains: (name) => classes.has(name)
        },
        addEventListener(type, listener) { listeners.set(type, listener); },
        click() { return listeners.get('click')?.({ target: this, preventDefault() {} }); }
    };
}

test('configuration export uses the desktop save dialog for a detached download link', async () => {
    const elements = new Map();
    const ids = [
        'btn-export-config', 'config-modal', 'config-modal-title', 'config-modal-action',
        'config-modal-hint', 'config-modal-file-hint', 'config-import-mode-group',
        'config-import-mode-replace', 'config-import-mode-append', 'input-config-file',
        'config-export-providers', 'config-export-models', 'config-export-settings',
        'config-export-prompts', 'config-export-workflows'
    ];
    ids.forEach((id) => elements.set(id, createElement({ checked: id !== 'config-export-workflows' })));
    const documentRef = {
        getElementById: (id) => elements.get(id) || null,
        querySelector: () => ({ value: 'replace' }),
        createElement: () => createElement()
    };
    const saved = [];
    const api = createUiControllerApi({
        state: { providers: [], models: [], workflowTabs: [] },
        panelManager: {}, settingsModal: {}, clearHistory: async () => true,
        getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
        historyPreviewApi: {}, historyFullscreenApi: {}, settingsControllerApi: {},
        applyHistoryGridCols: () => {}, saveState: () => {}, showToast: () => {},
        copyToClipboard: () => {}, downloadImage: () => {}, initFeatureModules: () => {},
        documentRef, localStorageRef: { getItem: () => '[]', setItem: () => {} },
        indexedDbRef: {}, locationRef: { reload: () => {} }, confirmRef: () => false, alertRef: () => {},
        desktopRef: { saveFile: async (name, mime, blob) => saved.push({ name, mime, blob }) }
    });

    api.initUI();
    elements.get('btn-export-config').click();
    await elements.get('config-modal-action').click();

    assert.equal(saved.length, 1);
    assert.match(saved[0].name, /^CainFlow_Config_.*\.zip$/);
    assert.equal(saved[0].mime, 'application/zip');
    assert.ok(saved[0].blob instanceof Blob);
});
