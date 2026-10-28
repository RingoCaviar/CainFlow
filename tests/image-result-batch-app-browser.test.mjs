import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const originals = await Promise.all(['red', 'orange', 'yellow', 'blue', 'green'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};

async function controlled(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.resultBatchRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy'&&options.body&&typeof JSON.parse(options.body).prompt==='string'){
            resultBatchRequests.push(JSON.parse(options.body));const images=${JSON.stringify(originals)};
            return new Response(JSON.stringify({data:[{b64_json:images[(resultBatchRequests.length-1)%images.length].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});
        }return nativeFetch(url,options);
    };` });
    await reloadAppBrowser(app);
}
async function saved(app) {
    return app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
}
async function run(app, count) {
    await app.evaluate("document.getElementById('btn-run').click()");
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='source')?.mediaAssetKeys?.length===${count})`);
    await app.waitFor("!document.getElementById('source-prompt').disabled && Boolean(document.querySelector('#source-image-results .image-node-result-count'))");
}
async function openBatch(app, count) {
    await app.evaluate("document.querySelector('#source-image-results .image-node-result-count').click()");
    await app.waitFor(`document.querySelectorAll('#source-image-results [data-result-index]').length===${count} && !document.querySelector('#source-image-results .image-node-result-batch').hidden`);
}
async function select(app, id, additive = false) {
    await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:650,clientY:220,ctrlKey:${additive}}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:650,clientY:220}))`);
}

test('the whole result batch is navigable without changing card height or downstream batch output', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'source', type: 'ImageGenerate', x: 80, y: 90, apiConfigId: 'image', providerId: 'p', prompt: 'batch navigation', generationCount: 12 },
        { id: 'sink', type: 'ImagePreview', x: 640, y: 90 },
        { id: 'note', type: 'Text', x: 640, y: 550, text: 'verify the whole batch' }
    ], connections: [{ id: 'whole-batch', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' }] }, async app => {
        await controlled(app); await run(app, 12);
        const before = (await saved(app)).nodes.find(node => node.id === 'source');
        const height = await app.evaluate("document.getElementById('source').offsetHeight");
        await openBatch(app, 12);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('#source-image-results [data-result-index]')).map(element=>Number(element.dataset.resultIndex))"), Array.from({ length: 12 }, (_, index) => index));
        await app.evaluate("document.querySelector('#source-image-results [data-result-index=\"0\"]').click()");
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count').textContent==='1 / 12'");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='source')?.imagePreviewIndex===0)");
        assert.equal(await app.evaluate("document.getElementById('source').offsetHeight"), height);
        assert.deepEqual((await saved(app)).nodes.find(node => node.id === 'source').mediaAssetKeys, before.mediaAssetKeys);
        await app.evaluate("document.querySelector('#source-image-results .image-node-result-batch-grid').scrollTo({top:10000})");
        await app.waitFor("document.querySelector('#source-image-results [data-result-index=\"11\"] img')?.naturalWidth>0");
        await app.evaluate("document.querySelector('#source-image-results [data-result-index=\"11\"]').focus({preventScroll:true})");
        assert.equal(await app.evaluate("document.activeElement?.dataset.resultIndex"), '11');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count').textContent==='12 / 12'");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-batch').hidden");
        assert.equal(await app.evaluate("document.getElementById('source').offsetHeight"), height);

        // Run the unmodified downstream nodes through the visible selected-only
        // menu, so the source's current view is tested as a full batch output.
        await select(app, 'sink'); await select(app, 'note', true);
        await app.evaluate("window.batchDownstreamFinished=false;new MutationObserver(records=>{if(records.some(record=>Array.from(record.addedNodes).some(node=>node.textContent?.includes('工作流运行完成'))))window.batchDownstreamFinished=true}).observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('sink').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:700,clientY:240}));document.getElementById('context-menu-run-selected').click()");
        await app.waitFor('window.batchDownstreamFinished===true');
        assert.equal(await app.evaluate("document.querySelector('#sink-preview .image-save-preview-counter').textContent.endsWith('/12')"), true);
        assert.equal(await app.evaluate('resultBatchRequests.length'), 12, 'browsing and downstream execution do not regenerate the source');
        assert.deepEqual((await saved(app)).nodes.find(node => node.id === 'source').mediaAssetKeys, before.mediaAssetKeys);
    });
});

test('whole-batch navigation retains a missing first slot and opens the second original without regenerating', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'source', type: 'ImageGenerate', x: 80, y: 90, width: 420, apiConfigId: 'image', providerId: 'p', prompt: 'missing navigation', generationCount: 3 }
    ], connections: [] }, async app => {
        await controlled(app); await run(app, 3);
        const before = (await saved(app)).nodes.find(node => node.id === 'source');
        const digest = createHash('sha256').update(Buffer.from(originals[0].split(',')[1], 'base64')).digest('hex');
        await unlink(join(app.server.dataDir, 'assets', digest.slice(0, 2), digest + '.png'));
        await reloadAppBrowser(app);
        await openBatch(app, 3);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('#source-image-results [data-result-index]')).map(element=>Number(element.dataset.resultIndex))"), [0, 1, 2]);
        await app.waitFor("document.querySelector('#source-image-results [data-result-index=\"0\"]').textContent.includes('原图缺失')");
        await app.evaluate("document.querySelector('#source-image-results [data-result-index=\"1\"]').click()");
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count').textContent==='2 / 3'");
        await app.evaluate("document.querySelector('#source-image-results .image-node-result-count').click();document.querySelector('#source-image-results [data-result-action=preview]').click()");
        await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), originals[1]);
        assert.equal(await app.evaluate('resultBatchRequests.length'), 0);
        assert.deepEqual((await saved(app)).nodes.find(node => node.id === 'source').mediaAssetKeys, before.mediaAssetKeys);
    });
});
