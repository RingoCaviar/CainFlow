import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { DEFAULT_THEME_ID } from '../js/core/constants.js';
import { createInitialState } from '../js/core/state.js';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('a new session starts with the light theme', () => {
    assert.equal(DEFAULT_THEME_ID, 'light');
    assert.equal(createInitialState().themeId, DEFAULT_THEME_ID);
});

test('the first paint uses the light theme before stored settings arrive', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const bootstrapScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    const attributes = new Map();
    const documentElement = {
        style: {},
        classList: { toggle() {} },
        setAttribute(name, value) { attributes.set(name, value); }
    };
    const pendingFetch = new Promise(() => {});
    const window = {};

    vm.runInNewContext(bootstrapScript, {
        document: { documentElement },
        window,
        fetch: () => pendingFetch
    });

    assert.equal(attributes.get('data-app-theme'), DEFAULT_THEME_ID);
    assert.equal(documentElement.style.colorScheme, 'light');
});

test('the UI bootstrap persistence fallback uses the default theme policy', () => {
    const stored = new Map();
    const state = {
        themeId: '',
        globalAnimationEnabled: true,
        workflowTabs: [{
            workflowId: 'migrated-id',
            name: 'legacy',
            data: { workflowId: 'migrated-id' },
            identityPendingSave: true
        }],
        activeWorkflowName: '',
        workflowOrder: [],
        workflowFolders: [],
        workflowSidebarWidth: 320,
        dragging: null,
        resizing: null
    };
    const sessionManager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
        localStorageRef: {
            setItem(key, value) { stored.set(key, value); }
        },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() {},
        updateAllConnections() {},
        updatePortStyles() {}
    });

    assert.equal(sessionManager.saveState(), true);
    assert.equal(JSON.parse(stored.get('cainflow_ui_bootstrap')).themeId, DEFAULT_THEME_ID);
    assert.equal(JSON.parse(stored.get('session')).workflowTabs[0].identityPendingSave, true);
});
