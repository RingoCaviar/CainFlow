import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeneralSettings } from '../js/features/settings/general-settings.js';

test('cache usage separates unique physical media from overlapping owner distribution', async () => {
    const originalFetch = globalThis.fetch;
    const elements = new Map(['cache-size-display', 'usage-workflow-media', 'usage-import-media', 'usage-history', 'usage-thumbnail-media', 'usage-local']
        .map((id) => [id, { textContent: '' }]));
    let requestedUrl = '';
    globalThis.fetch = async (url) => (requestedUrl = url, { ok: true, json: async () => ({
        actualMediaBytes: 1024 * 1024,
        documentBytes: 128,
        mediaReferenceDistribution: {
            'workflow-node': { assets: 2, bytes: 1024 * 1024 },
            history: { assets: 1, bytes: 1024 * 1024 }
        }
    }) });
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets', getActiveWorkflowId: () => 'workflow-a', documentRef: { getElementById: (id) => elements.get(id) || null } },
            dialogs: {}
        });
        await api.updateCacheUsage();
        assert.equal(elements.get('cache-size-display').textContent, '1.00 MB');
        assert.equal(elements.get('usage-workflow-media').textContent, '2 项 · 1.00 MB');
        assert.equal(elements.get('usage-history').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-import-media').textContent, '0 项 · 0.00 MB');
        assert.match(requestedUrl, /workflowId=workflow-a/);
    } finally { globalThis.fetch = originalFetch; }
});
