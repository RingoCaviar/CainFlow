import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptLibraryApi } from '../js/features/prompts/prompt-library.js';

test('disk storage facade hydrates and persists legacy synchronous keys', async () => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (!options.method) {
            const name = String(url).split('/').pop();
            const values = {
                session: { nodes: [{ id: 'n1' }] },
                update_state: { cainflow_update_status: 'latest' }
            };
            return { ok: true, json: async () => ({ value: values[name] ?? null }) };
        }
        return { ok: true, json: async () => ({ success: true }) };
    };

    const { diskStorage, hydrateDiskStorage } = await import('../js/services/storage-documents.js');
    await hydrateDiskStorage();
    assert.equal(JSON.parse(diskStorage.getItem('nodeflow_ai_state')).nodes[0].id, 'n1');
    assert.equal(diskStorage.getItem('cainflow_update_status'), 'latest');

    diskStorage.setItem('cainflow_prompt_library', JSON.stringify([{ id: 'p1' }]));
    diskStorage.setItem('cainflow_update_version', 'v9');
    diskStorage.setItem('nodeflow_ai_viewport_state', JSON.stringify({ 'workflow-a': { x: 1, y: 2, zoom: 1.5 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await diskStorage.flushPromise;

    const writes = calls.filter((call) => call.options.method === 'PUT');
    assert.ok(writes.some((call) => call.url.endsWith('/prompt_library')));
    assert.ok(writes.some((call) => call.url.endsWith('/update_state')));
    assert.ok(writes.some((call) => call.url.endsWith('/viewport_state')));
});

test('shared prompt writes wait for durability and merge saves across editor instances', async t => {
    let document = { value: [{ id: 'legacy', name: '已有', content: '保留的文本' }], updatedAt: 10 };
    let rejectWrites = false;
    let conflicts = 0;
    let letWritesContinue;
    let firstWriteStarted;
    const firstWrite = new Promise(resolve => { firstWriteStarted = resolve; });
    const allowWrites = new Promise(resolve => { letWritesContinue = resolve; });
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        assert.equal(url, '/api/storage/documents/prompt_library');
        if (!options.method) {
            const snapshot = structuredClone(document);
            return { ok: true, json: async () => snapshot };
        }
        const { value, expectedUpdatedAt } = JSON.parse(options.body);
        firstWriteStarted();
        await allowWrites;
        if (rejectWrites) return { ok: false, status: 500 };
        if (expectedUpdatedAt !== document.updatedAt) {
            conflicts++;
            return { ok: false, status: 409 };
        }
        document = { value, updatedAt: document.updatedAt + 1 };
        return { ok: true, json: async () => ({ updatedAt: document.updatedAt }) };
    });
    async function editor(instance) {
        const { diskStorage } = await import(`../js/services/storage-documents.js?editor=${instance}`);
        return createPromptLibraryApi({
            localStorageRef: diskStorage,
            documentRef: { getElementById: () => null, querySelector: () => null },
            confirmRef: () => false
        });
    }
    const left = await editor('left'), right = await editor('right');
    let acknowledged = false;
    const first = left.upsertPrompt({ name: '甲', content: '竖幅' }).then(prompt => {
        acknowledged = true;
        return prompt;
    });
    const second = right.upsertPrompt({ name: '乙', content: '横幅' });
    await firstWrite;
    assert.equal(acknowledged, false);
    letWritesContinue();
    const [created] = await Promise.all([first, second]);
    assert.equal(conflicts, 1);
    const restarted = await editor('restarted');
    const page = await restarted.listPrompts({ limit: 1 });
    assert.equal(page.total, 3);
    assert.equal(page.nextOffset, 1);
    assert.deepEqual((await restarted.listPrompts()).prompts.map(prompt => prompt.name).sort(), ['乙', '已有', '甲']);
    const updated = await restarted.upsertPrompt({ name: '甲', content: '新比例' });
    assert.equal(updated.id, created.id);
    assert.equal((await left.listPrompts({ query: '新比例' })).prompts[0].name, '甲');
    rejectWrites = true;
    await assert.rejects(right.upsertPrompt({ name: '失败', content: '不可见' }), /HTTP 500/);
    assert.equal((await left.listPrompts({ query: '失败' })).total, 0);
    await assert.rejects(right.upsertPrompt({ name: '已过期', content: '不可见' }, { isCurrent: () => false }), /会话已变化/);
});

test('one editor publishes prompt saves in the same order the user requested them', async t => {
    const key = 'cainflow_prompt_library';
    const { diskStorage } = await import('../js/services/storage-documents.js?same-editor');
    let stored = { value: [], updatedAt: 0 };
    let putCalls = 0;
    let finishFirst;
    let markFirstStarted;
    const canFinish = new Promise(resolve => { finishFirst = resolve; });
    const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
        if (!options.method) {
            const snapshot = structuredClone(stored);
            return { ok: true, json: async () => snapshot };
        }
        const { value, expectedUpdatedAt } = JSON.parse(options.body);
        assert.equal(expectedUpdatedAt, stored.updatedAt);
        stored = { value, updatedAt: stored.updatedAt + 1 };
        if (++putCalls === 1) {
            markFirstStarted();
            await canFinish;
        }
        return { ok: true };
    });
    const first = diskStorage.updateCurrentDocument(key, values => [...values, { id: 'one' }]);
    await firstStarted;
    const second = diskStorage.updateCurrentDocument(key, values => [...values, { id: 'two' }]);
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(putCalls, 1);
    } finally {
        finishFirst();
    }
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(diskStorage.getItem(key)), [{ id: 'one' }, { id: 'two' }]);
});

test('prompt authorization is checked after large body preparation and before network retry', async t => {
    const key = 'cainflow_prompt_library';
    const { diskStorage } = await import('../js/services/storage-documents.js?authorized-write');
    let current = true;
    let writes = 0;
    let deliverBody;
    let worker;
    const preparingBody = new Promise(resolve => { deliverBody = resolve; });
    const originalWorker = globalThis.Worker;
    globalThis.Worker = class {
        constructor() { worker = this; }
        addEventListener(type, listener) { this[type] = listener; }
        postMessage({ id, json }) {
            deliverBody(() => this.message({ data: { id, body: new Blob([json]) } }));
        }
        terminate() {}
    };
    t.after(() => {
        worker?.error();
        if (originalWorker === undefined) delete globalThis.Worker;
        else globalThis.Worker = originalWorker;
    });
    t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
        if (!options.method) return { ok: true, json: async () => ({ value: [], updatedAt: 0 }) };
        writes++;
        current = false;
        throw new TypeError('Keepalive quota exceeded');
    });
    const encoding = diskStorage.updateCurrentDocument(key, () => [{ content: 'x'.repeat(70_000) }], { isCurrent: () => current });
    const finishEncoding = await preparingBody;
    current = false;
    finishEncoding();
    await assert.rejects(encoding, /会话已变化/);
    assert.equal(writes, 0);

    current = true;
    await assert.rejects(diskStorage.updateCurrentDocument(key, () => [{ content: 'small' }], { isCurrent: () => current }), /会话已变化/);
    assert.equal(writes, 1);
});
