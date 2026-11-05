import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('saving an image-heavy recovery session serializes once and sends an intact binary body', async () => {
    const originalFetch = globalThis.fetch, parse = JSON.parse, stringify = JSON.stringify;
    const image = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024);
    const document = { promptAgent: { messages: [{ referenceImages: [{ dataUrl: image }] }] }, nodes: [], connections: [] };
    const state = { nodes: new Map(), connections: [], workflowTabs: [{ name: 'Heavy', workflowId: 'heavy', data: document }] };
    let largeParses = 0, largeSerializations = 0;
    const requests = [];
    let storage;
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?heavy=${Date.now()}`));
        const manager = createSessionManagerApi({ state, storageKey: 'nodeflow_ai_state', localStorageRef: storage,
            documentRef: { getElementById: () => null }, nodeSerializer: { buildStatePayload: () => ({}) },
            getWorkflowSnapshot: () => ({ active: { workflowId: 'heavy', label: 'Heavy' }, open: [{ workflowId: 'heavy', label: 'Heavy' }] }), showToast() {} });
        JSON.parse = (...args) => { if (args[0]?.length > 1024 * 1024) largeParses++; return parse(...args); };
        JSON.stringify = (...args) => { const result = stringify(...args); if (result?.length > 1024 * 1024) largeSerializations++; return result; };
        assert.equal(manager.saveState(), true);
        await storage.flushPromise;
    } finally {
        JSON.parse = parse; JSON.stringify = stringify; globalThis.fetch = originalFetch;
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
    }
    assert.equal(largeParses, 0, 'do not decode the freshly serialized recovery document');
    assert.equal(largeSerializations, 1, 'do not serialize the same image bytes again for transport');
    const request = requests.find(item => item.url.endsWith('/session'));
    assert.ok(request.options.body instanceof Blob, 'large saves must avoid fetch string conversion on the input thread');
    assert.equal(request.options.keepalive, false);
    const persisted = JSON.parse(await request.options.body.text()).value;
    assert.equal(persisted.workflowTabs[0].data.promptAgent.messages[0].referenceImages[0].dataUrl, image);
    assert.deepEqual(JSON.parse(storage.getItem('nodeflow_ai_state')), persisted);
});

test('a session larger than the browser keepalive quota is still written to disk', async () => {
    const originalFetch = globalThis.fetch;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
        const bodyBytes = new TextEncoder().encode(options.body || '').byteLength;
        if (options.keepalive === true && bodyBytes > 64 * 1024) {
            throw new TypeError('Keepalive request exceeds the browser quota');
        }
        writes.push({ url, options });
        return { ok: true };
    };
    try {
        const { diskStorage } = await import(`../js/services/storage-documents.js?large-session=${Date.now()}`);
        diskStorage.setItem('nodeflow_ai_state', JSON.stringify({
            workflowTabs: [{ workflowId: 'workflow-unsaved', data: 'x'.repeat(70 * 1024) }]
        }));
        await diskStorage.flushPromise;
        if (diskStorage.retryTimer) clearTimeout(diskStorage.retryTimer);

        assert.equal(diskStorage.lastError, null);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].url, '/api/storage/documents/session');
        assert.equal(writes[0].options.keepalive, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('background JSON encoding preserves each snapshot when replies arrive out of order and recovers from a worker error', async () => {
    const originalWorker = globalThis.Worker;
    const workers = [];
    class FakeWorker {
        constructor() { this.handlers = {}; this.requests = []; workers.push(this); }
        addEventListener(type, handler) { this.handlers[type] = handler; }
        postMessage(request) { this.requests.push(request); }
        terminate() { this.terminated = true; }
        complete(index) {
            const { id, json } = this.requests[index];
            this.handlers.message({ data: { id, body: new Blob([json], { type: 'application/json' }) } });
        }
    }
    globalThis.Worker = FakeWorker;
    try {
        const { createLargeJsonBody } = await import(`../js/services/large-json-body.js?test=${Date.now()}`);
        const first = createLargeJsonBody('{"text":"第一份😀"}');
        const second = createLargeJsonBody('{"text":"second"}');
        workers[0].complete(1); workers[0].complete(0);
        assert.equal(await (await first).text(), '{"text":"第一份😀"}');
        assert.equal(await (await second).text(), '{"text":"second"}');
        const interrupted = createLargeJsonBody('{"text":"retained"}');
        workers[0].handlers.error();
        assert.equal(await (await interrupted).text(), '{"text":"retained"}');
        assert.equal(workers[0].terminated, true);
        const next = createLargeJsonBody('{"text":"next"}');
        workers[1].complete(0);
        assert.equal(await (await next).text(), '{"text":"next"}');
    } finally { globalThis.Worker = originalWorker; }
});

test('a multibyte session beyond the keepalive quota retains the latest snapshot during an in-flight save', async () => {
    const originalFetch = globalThis.fetch;
    const bodies = [], completions = [];
    let storage;
    globalThis.fetch = async (_url, options) => {
        assert.equal(options.keepalive, false, 'UTF-8 byte size, not character count, decides keepalive');
        assert.ok(options.body instanceof Blob);
        bodies.push(await options.body.text());
        return new Promise(resolve => completions.push(() => resolve({ ok: true })));
    };
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?unicode=${Date.now()}`));
        const old = JSON.stringify({ text: '画'.repeat(30 * 1024), version: 1 });
        const latest = JSON.stringify({ text: '布'.repeat(30 * 1024), version: 2 });
        storage.setSerializedJSON('nodeflow_ai_state', old);
        storage.setSerializedJSON('nodeflow_ai_state', latest);
        let confirmed = false;
        const saving = storage.waitForKey('nodeflow_ai_state').then(() => { confirmed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(confirmed, false);
        assert.deepEqual(bodies.map(body => JSON.parse(body).value.version), [1]);
        completions[0]();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(confirmed, false, 'confirmation must wait for the newer snapshot too');
        assert.deepEqual(bodies.map(body => JSON.parse(body).value.version), [1, 2]);
        completions[1]();
        await saving;
        assert.equal(storage.getItem('nodeflow_ai_state'), latest);
        assert.deepEqual(JSON.parse(bodies[1]).value, JSON.parse(latest));
    } finally {
        globalThis.fetch = originalFetch;
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
    }
});
