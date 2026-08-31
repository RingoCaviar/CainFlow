import assert from 'node:assert/strict';
import test from 'node:test';

test('one continuous disk outage reports once and a later outage reports again', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const retries = [];
    let shouldFail = true;
    globalThis.fetch = async () => {
        if (shouldFail) throw new TypeError('disk unavailable');
        return { ok: true };
    };
    globalThis.setTimeout = (callback) => { retries.push(callback); return retries.length; };
    try {
        const { diskStorage } = await import(`../js/services/storage-documents.js?error-cycle=${Date.now()}`);
        let notifications = 0;
        diskStorage.onError = () => { notifications += 1; };

        diskStorage.setItem('nodeflow_ai_state', JSON.stringify({ activeWorkflowId: 'workflow-a' }));
        await diskStorage.flushPromise;
        assert.equal(notifications, 1);

        retries.shift()();
        await diskStorage.flushPromise;
        assert.equal(notifications, 1);

        shouldFail = false;
        retries.shift()();
        await diskStorage.flushPromise;

        shouldFail = true;
        diskStorage.setItem('nodeflow_ai_state', JSON.stringify({ activeWorkflowId: 'workflow-b' }));
        await diskStorage.flushPromise;
        assert.equal(notifications, 2);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
    }
});
