import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('history deletion preserves the file on cancel and deletes it once after confirmation', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [], providers: [{ id: 'p', name: 'test', endpoint: 'https://controlled.test/v1', apikey: 'test' }], models: [{ id: 'chat', name: 'test', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }] }, async app => {
        const directory = join(app.server.dataDir, 'exports');
        await writeFile(join(directory, 'delete-me.png'), await readFile(new URL('./fixtures/reference-red.png', import.meta.url)));
        await app.evaluate(`window.deletions = 0; const originalFetch = fetch;
            window.fetch = (url, options = {}) => {
                if (String(url).startsWith('/api/storage/library/') && options.method === 'DELETE') deletions++;
                return originalFetch(url, options);
            };
            window.confirm = () => { throw new Error('Native confirmation is forbidden'); };
            document.getElementById('btn-history').click()`);
        await app.waitFor("!!document.querySelector('#history-list .delete-btn')");
        await app.evaluate("document.querySelector('#history-list .delete-btn').click()");
        await app.waitFor("!!document.querySelector('#app-action-dialog:not(.hidden)')");
        assert.equal(await app.evaluate('deletions'), 0);
        await app.evaluate("document.querySelector('#app-action-dialog [data-dialog-style-1-action=cancel]').click()");
        assert.deepEqual(await readdir(directory), ['delete-me.png']);
        await app.evaluate("document.querySelector('#history-list .delete-btn').click()");
        await app.waitFor("!!document.querySelector('#app-action-dialog:not(.hidden)')");
        await app.evaluate("const button = document.querySelector('#app-action-dialog [data-dialog-style-1-action=confirm]'); button.click(); button.click()");
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length === 0");
        assert.equal(await app.evaluate('deletions'), 1);
        assert.deepEqual(await readdir(directory), []);
    });
});
