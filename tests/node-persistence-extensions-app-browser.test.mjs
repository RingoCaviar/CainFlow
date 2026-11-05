import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';
import { readFile } from 'node:fs/promises';

const extension = { vendor: 'future-plugin', nested: [null, { flag: false, zero: 0 }], text: '保留未知配置' };
const opaque = { ...JSON.parse('{"__proto__":{"futureRoot":0}}'), vendorExtension: extension, futureZero: 0, futureFalse: false, futureNull: null,
    data: { ...JSON.parse('{"__proto__":{"futureData":false}}'), vendorData: extension, futureList: [0, false, null] } };
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value)");
const oldImage = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
function assertOpaque(node) {
    assert.deepEqual(node.vendorExtension, extension);
    assert.equal(node.futureZero, 0); assert.equal(node.futureFalse, false); assert.equal(node.futureNull, null);
    assert.deepEqual(node.data.vendorData, extension); assert.deepEqual(node.data.futureList, [0, false, null]);
    assert.equal(Object.hasOwn(node, '__proto__'), true); assert.equal(Object.hasOwn(node.data, '__proto__'), true);
}
async function saveFile(app) {
    await waitForAutosave(app);
    return app.evaluate("fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json())");
}

test('old image sizes and opaque node JSON survive real restore, explicit save, copy, undo redo and reopen', { timeout: 60000 }, async () => {
    const input = { id: 'old-prompt-edge', from: { nodeId: 'text', port: 'text', futureEndpoint: extension }, to: { nodeId: 'image', port: 'prompt', futureEndpoint: [false, 0] }, type: 'text', futureEdge: extension };
    await withAppBrowser({ ...configuration, nodes: [
        { ...opaque, id: 'text', type: 'Text', x: 20, y: 80, text: 'known text' },
        { ...opaque, id: 'image', type: 'ImageGenerate', x: 500, y: 80, width: 260, height: 220, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'known local draft', generationRevision: { version: 1, dirty: true } },
        { ...opaque, id: 'color', type: 'ColorReset', x: 900, y: 80, width: 280, height: 210, userResized: true, imageDescription: 'known source annotation' }
    ], connections: [input] }, async app => {
        const first = await saveFile(app);
        for (const node of first.nodes) assertOpaque(node);
        assert.deepEqual(first.connections, [input]);
        assert.equal(first.nodes.find(node => node.id === 'image').generationRevision.dirty, true);
        assert.equal(first.nodes.find(node => node.id === 'color').imageDescription, 'known source annotation');
        const geometry = await app.evaluate("['image','color'].map(id=>{const node=document.getElementById(id);return {id,left:node.style.left,top:node.style.top,width:node.offsetWidth,height:node.offsetHeight}})");
        assert.deepEqual(geometry, [{ id: 'image', left: '500px', top: '80px', width: 260, height: 220 }, { id: 'color', left: '900px', top: '80px', width: 280, height: 210 }]);
        await app.evaluate("document.getElementById('image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:150}));document.getElementById('context-menu-copy-nodes').click();document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:800,clientY:480}));document.getElementById('context-menu-paste-nodes').click()");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===4");
        const copiedFile = await saveFile(app), copy = copiedFile.nodes.find(node => !['text', 'image', 'color'].includes(node.id));
        assertOpaque(copy); assert.deepEqual([copy.width, copy.height], [260, 220]);
        await app.evaluate("document.querySelector('#image-parameter-panel:not([hidden]) [data-parameter-action=close]')?.click();document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===3");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('已撤回'))");
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===4");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('已重做'))");
        const redone = await saveFile(app);
        assertOpaque(redone.nodes.find(node => node.id === copy.id));
        assert.deepEqual(redone.connections.find(edge => edge.id === input.id), input);
        await reloadAppBrowser(app);
        const reopened = await saved(app);
        for (const node of reopened.nodes) assertOpaque(node);
        assert.equal(await app.evaluate("document.getElementById('image').offsetHeight"), 220);
        assert.equal(await app.evaluate("document.getElementById('image').offsetWidth"), 260);
    });
});

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').classList.contains('is-active')`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
}

test('background runtime and automatic saving preserve own JSON extensions while a failed new attempt cannot resurrect known old image fields', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.persistencePending=false;const persistenceFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){persistencePending=true;return await new Promise(resolve=>window.releasePersistenceFailure=()=>{persistencePending=false;resolve(new Response(JSON.stringify({error:{message:'known new failure'}}),{status:400,headers:{'Content-Type':'application/json'}}))})}}return persistenceFetch(url,options)};" });
        await reloadAppBrowser(app);
        const prototypeKeys = JSON.parse('{"__proto__":{"extensionMarker":"own JSON value"}}');
        const a = { ...prototypeKeys, workflowId: 'extensions-a', vendorWorkflow: extension, futureWorkflowFalse: false, futureWorkflowNull: null,
            canvas: { ...prototypeKeys, x: 0, y: 0, zoom: 1, vendorViewport: extension, futureViewportZero: 0 },
            providers: [{ id: 'legacy-private', apikey: 'never-export-legacy-secret' }], models: [{ id: 'old-only', modelId: 'old-only' }], apikey: 'never-export-global-key',
            nodes: [{ ...opaque, ...prototypeKeys, id: 'shared', type: 'ImageGenerate', x: 40, y: 160, width: 300, height: 220, userResized: true,
            apiConfigId: 'image', providerId: 'p', prompt: 'run A only', images: [oldImage], imageData: oldImage, imageDescription: 'known annotation remains',
            generationRevision: { version: 1, dirty: true }, data: { ...opaque.data, ...prototypeKeys, image: oldImage, images: [oldImage] } }], connections: [] };
        const b = { workflowId: 'extensions-b', nodes: [{ ...opaque, id: 'shared', type: 'Text', x: 40, y: 160, text: 'B remains visible', vendorExtension: { workflow: 'B' } }], connections: [] };
        for (const [name, data] of [['Extensions A', a], ['Extensions B', b]]) {
            assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(data))}}).then(response=>response.ok)`), true);
        }
        await activate(app, 'Extensions A');
        await app.waitFor("document.querySelector('#shared-image-results img')?.naturalWidth>0");
        await app.evaluate("document.getElementById('shared').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:220}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("persistencePending&&document.getElementById('shared-image-results').hidden");
        await activate(app, 'Extensions B');
        assert.equal(await app.evaluate("document.getElementById('shared-text').value"), 'B remains visible');
        await app.evaluate('releasePersistenceFailure()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Extensions A\"]').classList.contains('is-running')");
        await waitForAutosave(app);
        const completed = await app.evaluate("fetch('/api/workflows/Extensions%20A').then(response=>response.json())"), result = completed.nodes.find(node => node.id === 'shared');
        assert.deepEqual(completed.vendorWorkflow, extension); assert.equal(completed.futureWorkflowFalse, false); assert.equal(completed.futureWorkflowNull, null);
        assert.deepEqual(completed.canvas.vendorViewport, extension); assert.equal(completed.canvas.futureViewportZero, 0);
        for (const record of [completed, completed.canvas]) {
            assert.equal(Object.hasOwn(record, '__proto__'), true); assert.deepEqual(record.__proto__, prototypeKeys.__proto__);
        }
        for (const key of ['providers', 'models', 'apikey']) assert.equal(Object.hasOwn(completed, key), false, 'legacy application configuration is not re-exported as an extension');
        assertOpaque(result);
        assert.equal(Object.hasOwn(result, '__proto__'), true); assert.deepEqual(result.__proto__, prototypeKeys.__proto__);
        assert.equal(Object.hasOwn(result.data, '__proto__'), true); assert.deepEqual(result.data.__proto__, prototypeKeys.__proto__);
        assert.equal(result.imageDescription, 'known annotation remains');
        assert.equal(result.generationRevision.version, 1); assert.equal(result.generationRevision.dirty, true);
        for (const key of ['image', 'imageData', 'images', 'imageList', 'imageAssetKey', 'mediaAssetKeys']) assert.equal(Object.hasOwn(result, key), false, `${key} cannot return from an opaque restore snapshot`);
        assert.equal(JSON.stringify(result).includes(oldImage), false);
        const other = await app.evaluate("fetch('/api/workflows/Extensions%20B').then(response=>response.json())");
        assert.deepEqual(other.nodes[0].vendorExtension, { workflow: 'B' }); assert.equal(other.nodes[0].text, 'B remains visible');
        await activate(app, 'Extensions A'); await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.getElementById('shared-image-results').hidden"), true);
        assertOpaque((await saved(app)).nodes.find(node => node.id === 'shared'));
    });
});
