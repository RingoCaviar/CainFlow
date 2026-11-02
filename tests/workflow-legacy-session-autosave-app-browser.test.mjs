import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

test('unnamed legacy canvas becomes one durable workflow without an orphan exit guard', async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://example.test', apikey: 'test' }],
        nodes: [{ id: 'legacy-text', type: 'Text', x: 50, y: 100, text: 'keep this legacy content' }], connections: []
    }, async app => {
        await app.waitFor('window.__cainflowAppReady===true');
        const snapshot = await app.evaluate("import('/js/app/bootstrap.js').then(module=>module.bootstrapCainFlowApp()).then(app=>({open:app.workflowManagerApi.workflowDesk.snapshot().open,tabs:app.state.workflowTabs.map(tab=>tab.workflowId)}))");
        assert.equal(snapshot.open.length, 1);
        assert.ok(snapshot.open[0].label);
        assert.deepEqual(snapshot.tabs, [snapshot.open[0].workflowId]);
        await reloadAppBrowser(app);
        const restored = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)");
        assert.equal(restored.activeWorkflowId, snapshot.open[0].workflowId);
        assert.equal(restored.nodes.find(node=>node.id==='legacy-text').text, 'keep this legacy content');
    });
});
