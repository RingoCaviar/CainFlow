import assert from 'node:assert/strict';
import test from 'node:test';

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
