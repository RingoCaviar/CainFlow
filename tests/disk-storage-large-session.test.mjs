import assert from 'node:assert/strict';
import test from 'node:test';

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
