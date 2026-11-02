import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { withAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'source', type: 'ImageImport', x: 40, y: 160, width: 300, height: 300, userResized: true },
        { id: 'preview', type: 'ImagePreview', x: 550, y: 160, width: 300, height: 300, userResized: true }
    ],
    connections: [{ id: 'retained-reference', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image', extension: { retained: true } }]
};

const graph = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>({nodes:document.value.nodes,connections:document.value.connections}))");

test('the real application serves a burst of assets and reloads without losing stylesheets or the saved graph', { timeout: 90000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor('window.__cainflowAppReady===true');
        await waitForAutosave(app);
        const original = await graph(app);
        const assets = await Promise.all(Array.from({ length: 128 }, () => new Promise(resolve => {
            get(`${app.server.baseUrl}/css/modules/04-node-core.css`, { agent: false }, response => {
                let bytes = 0;
                response.on('data', chunk => { bytes += chunk.length; });
                response.on('end', () => resolve({ status: response.statusCode, bytes }));
                response.on('error', error => resolve({ error: error.code }));
            }).on('error', error => resolve({ error: error.code }));
        })));
        const failures = assets.filter(asset => asset.status !== 200 || !asset.bytes);
        assert.deepEqual(failures, [], `a real burst must serve all 128 local stylesheet requests; ${failures.length} failed`);
        for (let iteration = 0; iteration < 3; iteration++) {
            const previous = await app.evaluate('performance.timeOrigin');
            await app.send('Page.reload', { ignoreCache: true });
            // Each navigation gets one attempt. A refused stylesheet or script
            // request must fail this regression instead of being hidden by retry.
            await app.waitFor(`performance.timeOrigin!==${previous} && window.__cainflowAppReady===true && document.querySelectorAll('#nodes-layer > .node').length===2`);
            const surfaces = await app.evaluate("[...document.querySelectorAll('#nodes-layer>.node')].map(node=>({id:node.id,position:getComputedStyle(node).position,left:node.style.left,top:node.style.top,dots:[...node.querySelectorAll('.node-port:not([hidden]) .port-dot')].filter(dot=>dot.getClientRects().length).map(dot=>{const rect=dot.getBoundingClientRect();return {width:rect.width,height:rect.height}})}))");
            assert.ok(surfaces.every(node => node.position === 'absolute'), `reload ${iteration + 1} applies the real node positioning stylesheet: ${JSON.stringify(surfaces)}`);
            assert.ok(surfaces.every(node => node.dots.length >= 1 && node.dots.every(dot => dot.width > 0 && dot.height > 0)), `reload ${iteration + 1} restores measurable input and output anchors: ${JSON.stringify(surfaces)}`);
            assert.deepEqual(await graph(app), original, `reload ${iteration + 1} leaves the saved graph intact`);
        }
    });
});
