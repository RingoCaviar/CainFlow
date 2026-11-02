import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

test('refresh during restoration preserves open workflows and active identity', async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://example.test', apikey: 'test' }],
        nodes: [], connections: []
    }, async app => {
        const tabs = ['A', 'B'].map(name => ({
            name, workflowId: 'id-' + name,
            data: { workflowId: 'id-' + name, nodes: [], connections: [] }
        }));
        for (const tab of tabs) {
            await writeFile(join(app.server.workflowsDir, tab.name + '.json'), JSON.stringify(tab.data));
        }
        const readSession = async () => (await (await fetch(app.server.baseUrl + '/api/storage/documents/session')).json()).value;
        const pauseRequest = async (path, marker) => app.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `const original = window.fetch; window.fetch = async (url, options) => {
                if (String(url).includes(${JSON.stringify(path)}) && (!options?.method || options.method === 'GET')) {
                    window[${JSON.stringify(marker)}] = true;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                return original(url, options);
            };`
        });
        // Seed only after the previous live page has exited, so its legitimate exit save cannot overwrite the fixture.
        const loading = await pauseRequest('/api/storage/documents/session', 'sessionReadStarted');
        await app.send('Page.reload', { ignoreCache: true });
        await app.waitFor('window.sessionReadStarted === true');
        await fetch(app.server.baseUrl + '/api/storage/documents/session', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: {
                ...await readSession(), workflowTabs: tabs, activeWorkflowId: 'id-B',
                activeWorkflowName: 'B', workflowId: 'id-B', nodes: [], connections: []
            } })
        });
        await app.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: loading.identifier });
        const restoring = await pauseRequest('/api/storage/export-directory', 'restoreStarted');
        // Repeated refreshes while loadState awaits directory restoration must not persist empty defaults.
        for (let attempt = 0; attempt < 3; attempt++) {
            await app.send('Page.reload', { ignoreCache: true });
            await app.waitFor('window.restoreStarted === true');
            await delay(350);
            assert.deepEqual((await readSession()).workflowTabs.map(tab => tab.name), ['A', 'B']);
        }
        await app.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: restoring.identifier });
        await app.send('Page.reload', { ignoreCache: true });
        await app.waitFor('window.__cainflowAppReady === true');
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-name').textContent"), 'B');
        // Exercise a normal ready-page exit too: the protection must not disable later session persistence.
        await app.send('Page.reload', { ignoreCache: true });
        await app.waitFor('window.__cainflowAppReady === true');
        const session = await readSession();
        assert.deepEqual(session.workflowTabs.map(tab => tab.name), ['A', 'B']);
        assert.equal(session.activeWorkflowName, 'B');
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-name').textContent"), 'B');
    });
});
