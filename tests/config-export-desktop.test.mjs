import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiControllerApi } from '../js/features/ui/ui-controller.js';
import { readConfigArchive, readJsonEntry } from '../js/features/settings/config-archive.js';

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
        click() { return listeners.get('click')?.({ target: this, preventDefault() {} }); },
        change() { return listeners.get('change')?.({ target: this }); }
    };
}

function createHarness(state = { providers: [], models: [], workflowTabs: [] }) {
    const elements = new Map();
    const ids = [
        'btn-export-config', 'btn-import-config', 'config-modal', 'config-modal-title', 'config-modal-action',
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
    let finishImport;
    const imported = new Promise(resolve => { finishImport = resolve; });
    const api = createUiControllerApi({
        state,
        panelManager: {}, settingsModal: {}, clearHistory: async () => true,
        getHistory: async () => [], renderHistoryList: () => {}, renderLogs: () => {},
        historyPreviewApi: {}, historyFullscreenApi: {}, settingsControllerApi: {
            updateAllNodeModelDropdowns() {}, renderModels() {}, renderProviders() {}, renderGeneralSettings() {}, syncProxyToServer() {}
        },
        applyHistoryGridCols: () => {}, saveState: () => {}, showToast: (message, type) => finishImport({ message, type }),
        copyToClipboard: () => {}, downloadImage: () => {}, initFeatureModules: () => {},
        documentRef, localStorageRef: { getItem: () => '[]', setItem: () => {} },
        indexedDbRef: {}, locationRef: { reload: () => {} }, confirmRef: () => false, alertRef: () => {},
        desktopRef: { saveFile: async (name, mime, blob) => saved.push({ name, mime, blob }) }
    });
    api.initUI();
    return { elements, saved, imported };
}

test('configuration export uses the desktop save dialog for a detached download link', async () => {
    const { elements, saved } = createHarness();
    elements.get('btn-export-config').click();
    await elements.get('config-modal-action').click();

    assert.equal(saved.length, 1);
    assert.match(saved[0].name, /^CainFlow_Config_.*\.zip$/);
    assert.equal(saved[0].mime, 'application/zip');
    assert.ok(saved[0].blob instanceof Blob);
});

test('configuration ZIP export/import retains declared search abilities, compaction limits and literal Responses addresses', async () => {
    const models = ['none', 'web', 'images'].map((agentSearch, index) => ({
        id: `model${index}`, name: `模型${index}`, modelId: 'controlled-chat', protocol: 'openai',
        taskType: 'chat', providerIds: ['p'], agentSearch, autoCompactTokenLimit: 23456
    }));
    const providers = [{ id: 'p', name: '受控 Provider', endpoint: 'https://controlled.test/chat',
        autoComplete: false, responsesEndpoint: 'https://controlled.test/custom/responses' }];
    const source = createHarness({ models, providers, workflowTabs: [] });
    source.elements.get('btn-export-config').click();
    await source.elements.get('config-modal-action').click();
    const file = new File([source.saved[0].blob], 'config.zip', { type: 'application/zip' });
    const entries = await readConfigArchive(file);
    assert.deepEqual(readJsonEntry(entries, 'models/models.json'), models);
    assert.equal(readJsonEntry(entries, 'providers/providers.json')[0].responsesEndpoint, providers[0].responsesEndpoint);

    const restored = { models: [], providers: [], workflowTabs: [] };
    const destination = createHarness(restored);
    // Only import the model/provider blocks; the rest belongs to the user's own workspace.
    for (const key of ['settings', 'prompts']) destination.elements.get(`config-export-${key}`).checked = false;
    destination.elements.get('btn-import-config').click();
    await destination.elements.get('config-modal-action').click();
    const input = destination.elements.get('input-config-file');
    input.files = [file]; input.change();
    const outcome = await destination.imported;
    assert.equal(outcome.type, 'success', outcome.message);
    assert.deepEqual(restored.models.map(model => model.agentSearch), ['none', 'web', 'images']);
    assert.ok(restored.models.every(model => model.autoCompactTokenLimit === 23456));
    assert.equal(restored.providers[0].responsesEndpoint, providers[0].responsesEndpoint);
    assert.equal(restored.providers[0].autoComplete, false);
});
