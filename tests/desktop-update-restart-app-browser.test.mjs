import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('desktop restart wiring saves real workflows and retains Undo when the native helper fails', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }] }, async app => {
        await app.evaluate(`(async () => { window.restartApp = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            window.restartCalls = []; window.failRestart = true;
            window.__cainflowDesktop = { restartAfterUpdate: async id => {
                if (failRestart) throw new Error('controlled helper failure'); restartCalls.push(id); return true;
            } };
            restartApp.state.isRunning = true; })()`);
        assert.equal(await app.evaluate("cainflowPrepareExit({restartJobId:'test-job'})"), false);
        await app.evaluate('restartApp.state.isRunning = false');
        assert.equal(await app.evaluate("cainflowPrepareExit({restartJobId:'test-job'})"), false);
        assert.equal(await app.evaluate('document.body.inert'), false);
        assert.equal(await app.evaluate('!!restartApp.registry.sessionManagerApi.pushHistory()'), true);
        await app.evaluate('failRestart = false');
        assert.equal(await app.evaluate("cainflowPrepareExit({restartJobId:'test-job'})"), true);
        assert.deepEqual(await app.evaluate('restartCalls'), ['test-job']);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>!!d.value)"), true);
    });
});
