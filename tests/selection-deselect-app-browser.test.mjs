import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'Text', x: 60, y: 70, text: 'source' },
        { id: 'target', type: 'ImageGenerate', x: 510, y: 120, width: 320 },
        { id: 'other', type: 'ImageImport', x: 60, y: 500, width: 220 }],
    connections: [{ id: 'edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'prompt' }, type: 'text' }]
};

test('deselecting an image node clears its selection feedback and connected path emphasis', async () => {
    await withAppBrowser(session, async app => {
        const click = async point => {
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
                await app.send('Input.dispatchMouseEvent', { type, ...point, ...(type !== 'mouseMoved' ? { button: 'left', clickCount: 1 } : {}) });
            }
        };
        const nodePoint = id => app.evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.left+30,y:r.top+30}})()`);
        await click(await nodePoint('target'));
        await app.waitFor("document.getElementById('target').classList.contains('selected') && document.querySelector('[data-conn-id=edge]').classList.contains('selected')");
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await app.send('Input.dispatchMouseEvent', { type, x: 1000, y: 650, ...(type !== 'mouseMoved' ? { button: 'left', clickCount: 1 } : {}) });
        }
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.deepEqual(await app.evaluate("({node:document.getElementById('target').classList.contains('selected'),path:document.querySelector('[data-conn-id=edge]').classList.contains('selected'),panel:!document.getElementById('image-parameter-panel').hidden})"),
            { node: false, path: false, panel: false });
        await click(await nodePoint('target'));
        await app.waitFor("document.querySelector('[data-conn-id=edge]').classList.contains('selected')");
        await click(await nodePoint('other'));
        await app.waitFor("document.getElementById('other').classList.contains('selected') && !document.querySelector('[data-conn-id=edge]').classList.contains('selected')");
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('.node.selected').length===3 && document.querySelector('[data-conn-id=edge]').classList.contains('selected')");
        await click({ x: 1000, y: 650 });
        await app.waitFor("!document.querySelector('.node.selected') && !document.querySelector('[data-conn-id=edge]').classList.contains('selected')");
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections)"), session.connections);
    });
});
