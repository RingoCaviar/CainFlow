import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createDiskStorageApi } from '../js/services/storage-disk.js';
import { startCainflowServer } from './helpers/browser-theme-fixture.mjs';

test('cache cleanup HTTP actions shrink SQLite while retaining other workflows and Agent images', async () => {
    const server = await startCainflowServer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => originalFetch(new URL(url, server.baseUrl), options);
    try {
        let safety;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            safety = (await (await fetch('/api/storage/safety-status')).json()).safety;
            if (!safety.backgroundScanPending) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(safety.state, 'healthy');
        assert.equal(safety.backgroundScanPending, false);
        const storage = createDiskStorageApi(() => ({}));
        const other = await storage.putMediaAsset('data:image/png;base64,b3RoZXI=', 'workflow-node', 'other:node');
        const agent = await storage.putMediaAsset('data:image/png;base64,YWdlbnQ=', 'prompt-agent-result', 'agent:run');
        assert.ok(other?.asset_key && agent?.asset_key);
        const session = { workflowTabs: [
            { workflowId: 'other', data: { workflowId: 'other', nodes: [{ id: 'node', type: 'ImageGenerate', mediaAssetKeys: [other.asset_key] }] } },
            { workflowId: 'agent', data: { workflowId: 'agent', nodes: [], promptAgent: {
                archivedMessages: [{ runs: [{ runId: 'run', status: 'completed', mediaAssetKeys: [agent.asset_key] }] }]
            } } }
        ] };
        const putDocument = async (name, value) => {
            const response = await fetch(`/api/storage/documents/${name}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value })
            });
            assert.equal(response.ok, true);
        };
        await putDocument('session', session);
        const actions = [
            () => storage.clearOrphanedNodeAssets([], { detailed: true }),
            async () => (await fetch('/api/storage/maintenance', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear-temporary' })
            })).json(),
            () => storage.clearHistory({ detailed: true })
        ];
        for (const action of actions) {
            await putDocument('logs_state', { text: 'x'.repeat(2 * 1024 * 1024) });
            await putDocument('logs_state', { text: 'retained' });
            const before = statSync(join(server.dataDir, 'cainflow.db')).size;
            const outcome = await action();
            assert.equal(outcome.success, true);
            assert.equal(outcome.databaseCompaction?.status, 'completed', JSON.stringify(outcome));
            assert.ok(outcome.databaseCompaction.reclaimedBytes > 1024 * 1024);
            assert.ok(statSync(join(server.dataDir, 'cainflow.db')).size < before / 2);
            assert.deepEqual((await (await fetch('/api/storage/documents/session')).json()).value, session);
            for (const [key, text] of [[other.asset_key, 'other'], [agent.asset_key, 'agent']]) {
                const response = await fetch(`/api/storage/assets/${encodeURIComponent(key)}`);
                assert.equal(response.status, 200);
                assert.equal(await response.text(), text);
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
        await server.stop();
    }
});
