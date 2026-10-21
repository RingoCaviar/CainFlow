import assert from 'node:assert/strict';
import test from 'node:test';
import { flushSessionToDisk } from '../js/features/persistence/flush-session-to-disk.js';

test('concurrent session and preference writes do not exhaust the shared browser keepalive quota', async () => {
    const originalFetch = globalThis.fetch;
    let finishFirst;
    let inFlightBytes = 0;
    const writes = [];
    globalThis.fetch = async (url, options) => {
        writes.push(url);
        if (writes.length === 1) return new Promise(resolve => { finishFirst = () => resolve({ ok: true }); });
        const size = options.keepalive ? new TextEncoder().encode(options.body).byteLength : 0;
        if (inFlightBytes + size > 64 * 1024) throw new TypeError('Keepalive request exceeds shared quota');
        inFlightBytes += size;
        await new Promise(resolve => setTimeout(resolve, 0));
        inFlightBytes -= size;
        return { ok: true };
    };
    let storage;
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?concurrent=${Date.now()}`));
        storage.setItem('cainflow_logs_state', '{}');
        storage.setItem('nodeflow_ai_state', JSON.stringify({ promptAgent: { text: 'x'.repeat(40 * 1024) } }));
        storage.setItem('cainflow_notice', 'y'.repeat(40 * 1024));
        finishFirst();
        await storage.flushPromise;
        assert.equal(storage.lastError, null, 'Agent saveConversation must not report a keepalive quota failure');
        assert.equal(storage.pending.size, 0);
    } finally {
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
        globalThis.fetch = originalFetch;
    }
});

test('Agent confirms the session even when an unrelated preference fails, but reports real session failure', async () => {
    const originalFetch = globalThis.fetch;
    let failSession = false;
    let storage;
    globalThis.fetch = async (url) => ({ ok: url.endsWith('/session') ? !failSession : false, status: 503 });
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?confirmation=${Date.now()}`));
        const sessionManager = { flushSave() {
            storage.setItem('nodeflow_ai_state', JSON.stringify({ promptAgent: { messages: [{ runs: [{ mediaAssetKeys: ['media:image'] }] }] } }));
            storage.setItem('cainflow_ui_bootstrap', '{}');
            return true;
        } };
        await flushSessionToDisk(sessionManager, storage);
        assert.ok(storage.lastError, 'global error remains visible for the failing preference');
        failSession = true;
        await assert.rejects(flushSessionToDisk(sessionManager, storage), /会话保存失败：保存 session 失败: HTTP 503/);
        failSession = false;
        await flushSessionToDisk(sessionManager, storage);
    } finally {
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
        globalThis.fetch = originalFetch;
    }
});

test('shared keepalive quota consumed outside document storage falls back to an ordinary PUT', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    let storage;
    globalThis.fetch = async (_url, options) => {
        requests.push(options);
        if (options.keepalive) throw new TypeError('Other requests consumed keepalive quota');
        return { ok: true };
    };
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?fallback=${Date.now()}`));
        storage.setItem('nodeflow_ai_state', '{"workflowId":"test"}');
        await storage.waitForKey('nodeflow_ai_state');
        assert.deepEqual(requests.map(request => request.keepalive), [true, false]);
        assert.equal(requests[0].body, requests[1].body);
        assert.equal(storage.keepaliveBytes, 0);
    } finally {
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
        globalThis.fetch = originalFetch;
    }
});

test('an unrelated fast failure cannot finish the batch while the session is still writing', async () => {
    const originalFetch = globalThis.fetch;
    let finishSession, finishFirst;
    let storage;
    globalThis.fetch = async (url) => url.endsWith('/logs_state')
        ? new Promise(resolve => { finishFirst = () => resolve({ ok: true }); })
        : url.endsWith('/session')
        ? new Promise(resolve => { finishSession = () => resolve({ ok: true }); })
        : { ok: false, status: 503 };
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?ordering=${Date.now()}`));
        storage.setItem('cainflow_logs_state', '{}');
        storage.setItem('nodeflow_ai_state', '{}');
        storage.setItem('cainflow_ui_bootstrap', '{}');
        finishFirst();
        let confirmed = false;
        const saving = storage.waitForKey('nodeflow_ai_state').then(() => { confirmed = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(confirmed, false);
        finishSession();
        await saving;
        assert.equal(confirmed, true);
    } finally {
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
        globalThis.fetch = originalFetch;
    }
});
