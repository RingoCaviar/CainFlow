import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser } from './helpers/app-browser.mjs';

const images = await Promise.all(['red', 'blue', 'orange'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const session = { autoCheckUpdatesOnLoad: false, nodes: [], connections: [],
    models: [{ id: 'chat', modelId: 'chat', name: 'Controlled', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };

test('concurrent originals remain distinct when client time and randomness collide', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const results = await app.evaluate(`(async () => {
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            const storage = createDiskStorageApi(() => ({}));
            const now = Date.now, random = Math.random;
            Date.now = () => 1793680000000; Math.random = () => 0.25;
            try {
                return await Promise.all(${JSON.stringify(images)}.map(async (image, index) => {
                    try { return { index, result: await storage.saveHistoryEntry({ image, prompt: 'collision-' + index }) }; }
                    catch (error) { return { index, error: error.message }; }
                }));
            } finally { Date.now = now; Math.random = random; }
        })()`);
        assert.deepEqual(results.filter(result => result.error), [], JSON.stringify(results));
        const ids = results.map(result => result.result.fileId);
        assert.equal(new Set(ids).size, 3);
        for (const { index, result } of results) {
            assert.ok(Number.isSafeInteger(result.fileId));
            const response = await fetch(`${app.server.baseUrl}/api/storage/library/${result.fileId}/file`);
            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(images[index].split(',')[1], 'base64'));
        }
    });
});
