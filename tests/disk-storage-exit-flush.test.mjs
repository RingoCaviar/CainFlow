import assert from 'node:assert/strict';
import test from 'node:test';
import { diskStorage } from '../js/services/storage-documents.js';

test('writing the session during page exit starts its durable write before the event returns', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = (url, options = {}) => {
        requests.push({ url, options });
        return Promise.resolve({ ok: true });
    };
    let requestCount = 0;
    try {
        diskStorage.setItem('nodeflow_ai_state', JSON.stringify({ workflowTabs: [{ workflowId: 'workflow-a' }] }));
        requestCount = requests.length;
        await Promise.resolve();
        await Promise.resolve();
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(requestCount, 1);
    assert.equal(requests[0].url, '/api/storage/documents/session');
    assert.equal(requests[0].options.keepalive, true);
});
