import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const longTitle = '第一组参考来源的完整长标题，包含主体、光线与构图要求，展开之后必须完整阅读，不能只依赖鼠标悬停。';
const description = '保留主体的轮廓与连接结构。\n冷色环境光，背景留白，所有细节按原图保持。'.repeat(6);
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'single-a', type: 'ImageGenerate', x: -800, y: 0, customTitle: longTitle, imageDescription: description, apiConfigId: 'image', providerId: 'p', prompt: 'single-a', generationCount: 1 },
        { id: 'single-b', type: 'ImageGenerate', x: -800, y: 450, customTitle: '第二个单图来源', apiConfigId: 'image', providerId: 'p', prompt: 'single-b', generationCount: 1 },
        { id: 'batch', type: 'ImageGenerate', x: -800, y: 850, customTitle: '完整六张批次', apiConfigId: 'image', providerId: 'p', prompt: 'batch', generationCount: 6 },
        { id: 'target', type: 'ImageGenerate', x: 200, y: 20, width: 420, apiConfigId: 'image', providerId: 'p', prompt: 'target' },
        { id: 'other-target', type: 'ImageGenerate', x: 1400, y: 20, apiConfigId: 'image', providerId: 'p', prompt: 'other' }
    ],
    connections: [
        ...['single-a', 'single-b', 'batch'].map((id, order) => ({ id: `edge-${id}`, from: { nodeId: id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order })),
        { id: 'shared-batch', from: { nodeId: 'batch', port: 'image' }, to: { nodeId: 'other-target', port: 'referenceImages' }, type: 'image', order: 0 }
    ]
};

async function openReferences(app) {
    await app.evaluate("document.querySelector('#target .image-first-placeholder').click()");
    await app.waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='target' && !document.getElementById('image-parameter-panel').hidden");
    await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=reference]');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()");
    await app.waitFor("document.querySelector('#image-parameter-panel [data-parameter-group=reference]')?.hidden===false");
}

async function populateSources(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.referenceGalleryRequests=0;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy'&&options.body){window.referenceGalleryRequests++;return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(png)}}]}),{headers:{'Content-Type':'application/json'}})}
        return nativeFetch(url,options);
    };` });
    await reloadAppBrowser(app);
    for (const [id, count] of [['single-a', 1], ['single-b', 1], ['batch', 6]]) {
        await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='${id}')?.mediaAssetKeys?.length===${count})`);
        await app.waitFor(`!document.getElementById('${id}-prompt').disabled`);
    }
}

test('reference gallery shares rows for single sources, spans complete batches, without redundant source details', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await populateSources(app);
        await openReferences(app);
        const layout = await app.evaluate("(()=>{const gallery=document.querySelector('#target-reference-sources .image-reference-grid'),rows=[...gallery.querySelectorAll('.image-reference-group')];return {tops:rows.map(row=>row.offsetTop),widths:rows.map(row=>row.getBoundingClientRect().width),height:gallery.clientHeight,overflow:gallery.scrollWidth>gallery.clientWidth+1,slots:rows.map(row=>row.querySelectorAll('[data-source-image-index]').length),nodeHeight:document.getElementById('target').offsetHeight}})()");
        assert.equal(layout.tops[0], layout.tops[1], 'single-image sources share a compact row');
        assert.ok(layout.widths[2] > layout.widths[0] * 1.8, 'a multi-image source spans the gallery columns');
        assert.ok(layout.height <= 210);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.slots, [1, 1, 6]);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6', '7', '8']);

        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-details').length"), 0);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='single-a').imageDescription)"), description, 'source descriptions are retained as data');
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        for (let step = 0; step < 18; step += 1) {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft' });
        }
        assert.equal(await app.evaluate("(()=>{const gallery=document.querySelector('#target-reference-sources .image-reference-grid'),rows=[...gallery.querySelectorAll('.image-reference-group')];return rows[0].offsetTop!==rows[1].offsetTop&&gallery.scrollWidth<=gallery.clientWidth+1&&gallery.clientHeight<=210})()"), true,
            'reducing the editor width reduces columns without overflowing or losing batch slots');
        assert.equal(await app.evaluate("document.getElementById('target').offsetHeight"), layout.nodeHeight, 'gallery edits never change the image card height');
    });
});

test('canvas source enable control preserves every edge and source position while excluding the whole source from effective numbering', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await populateSources(app);
        await openReferences(app);
        const control = '#batch .node-bypass-btn';
        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-more, #target-reference-sources .image-reference-source-actions, #target-reference-sources .image-reference-source-status').length"), 0);
        await app.evaluate(`document.querySelector('${control}').click()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='batch')?.enabled===false)");
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections)"), session.connections);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-group')].map(row=>row.dataset.referenceConnection)"), ['edge-single-a', 'edge-single-b', 'edge-batch']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2']);
        assert.equal(await app.evaluate("document.querySelectorAll('[data-reference-connection=edge-batch] [data-source-image-index]').length"), 6,
            'disabled sources retain their complete batch positions for inspection');
        assert.equal(await app.evaluate("document.querySelector('[data-reference-connection=edge-batch]').dataset.enabled"), 'false');
        await app.evaluate(`document.querySelector('${control}').click()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='batch')?.enabled===true)");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6', '7', '8']);
        assert.equal(await app.evaluate('window.referenceGalleryRequests'), 8, 'source enable changes do not rerun generation');
        await reloadAppBrowser(app);
        await openReferences(app);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6', '7', '8']);
    });
});
