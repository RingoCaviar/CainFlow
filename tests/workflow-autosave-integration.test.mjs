import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

async function harness(t, { restoredDirty = false } = {}) {
    const disk = new Map(), requests = [], notices = [];
    let text = 'first', fail = false, release = null, hold = false, renameStarted = false;
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/workflows') return { ok: true, json: async () => ({ workflows: ['A', 'B'], folders: [] }) };
        if (options.headers?.['x-rename-to']) {
            renameStarted = true;
            await new Promise(resolve => { release = resolve; });
            const previousName = decodeURIComponent(url.split('/').at(-1));
            disk.set(decodeURIComponent(options.headers['x-rename-to']), disk.get(previousName));
            disk.delete(previousName);
            return { ok: true, json: async () => ({}) };
        }
        if (url.startsWith('/api/workflows/') && options.method === 'POST') {
            const data = JSON.parse(options.body);
            requests.push(data);
            if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
            if (fail) return { ok: false, status: 500, json: async () => ({ error: 'disk unavailable' }) };
            disk.set(decodeURIComponent(url.split('/').at(-1)), data);
            return { ok: true, json: async () => ({}) };
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    t.after(() => { globalThis.fetch = previous; });
    const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(), connections: [],
        selectedNodes: new Set(), canvas: { x: 0, y: 0, zoom: 1 } };
    const manager = createWorkflowManagerApi({ state,
        nodeSerializer: { serializeNodes: () => [{ id: 'text', type: 'Text', text }], buildStatePayload: () => ({}) },
        viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() {}, showToast: message => notices.push(message), panelManager: {},
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }), recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => null, replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
        prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        documentRef: { getElementById: () => null }, windowRef: {}, localStorageRef: { getItem: () => null, setItem() {} }
    });
    const data = id => ({ workflowId: id, nodes: [], connections: [], mediaOwnershipRevision: 0 });
    await manager.activateRestoredWorkflowState({ workflowTabs: ['A', 'B'].map(name => ({ name, workflowId: name, data: data(name), dirty: restoredDirty && name === 'A' })),
        activeWorkflowId: 'A', activeWorkflowName: 'A', workflowData: data('A') });
    return { manager, state, disk, requests, notices, edit(value) { text = value; manager.syncActiveWorkflowBeforeSessionSave({ dirty: true }); },
        fail(value) { fail = value; }, hold() { hold = true; }, release: () => release?.(), renameStarted: () => renameStarted };
}

test('a recovered unsaved workflow retries automatically without another edit', async t => {
    const h = await harness(t, { restoredDirty: true });
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(h.disk.get('A').nodes[0].text, 'first');
    assert.equal(h.manager.hasPendingAutosave(), false);
});

test('editing the active canvas and an inactive Agent conversation persists both without a save command', async t => {
    const h = await harness(t);
    h.edit('automatic');
    h.manager.mutatePromptAgentByWorkflowId('B', () => ({ messages: [{ role: 'user', content: 'background conversation' }] }));
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(h.disk.get('A').nodes[0].text, 'automatic');
    assert.equal(h.disk.get('B').promptAgent.messages[0].content, 'background conversation');
    assert.equal(h.manager.hasPendingAutosave(), false);
    assert.deepEqual(h.notices, []);
});

test('a slow write cannot clear a newer edit, and a failed flush remains retryable', async t => {
    const h = await harness(t);
    h.hold(); h.edit('old');
    const flushing = h.manager.flushAutosave();
    while (!h.requests.length) await new Promise(resolve => setImmediate(resolve));
    h.edit('new'); h.release();
    await flushing;
    assert.equal(h.disk.get('A').nodes[0].text, 'new');
    assert.equal(h.manager.hasPendingAutosave(), false);
    h.fail(true); h.edit('retained');
    assert.equal((await h.manager.flushAutosave()).results[0].status, 'failed');
    assert.equal(h.manager.hasPendingAutosave(), true);
    assert.equal(h.disk.get('A').nodes[0].text, 'new');
    h.fail(false); await h.manager.flushAutosave();
    assert.equal(h.disk.get('A').nodes[0].text, 'retained');
});

test('an atomic Agent canvas commit persists while the ordinary timer is suspended', async t => {
    const h = await harness(t);
    h.state.canvasPlanApplying = true;
    h.edit('atomic');
    assert.equal(await h.manager.saveActiveWorkflow(), true);
    assert.equal(h.disk.get('A').nodes[0].text, 'atomic');
    h.state.canvasPlanApplying = false;
});

test('edits made during a slow rename save only to the new path', async t => {
    const h = await harness(t);
    h.edit('before rename'); await h.manager.flushAutosave();
    const renamed = h.manager.workflowDesk.workflow('A').rename('Renamed');
    while (!h.renameStarted()) await new Promise(resolve => setImmediate(resolve));
    h.edit('during rename');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(h.requests.length, 1);
    h.release(); await renamed;
    await h.manager.flushAutosave();
    assert.equal(h.disk.has('A'), false);
    assert.equal(h.disk.get('Renamed').nodes[0].text, 'during rename');
});
