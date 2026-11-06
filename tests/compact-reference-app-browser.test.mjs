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
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=more]');if(!document.querySelector('#image-parameter-panel .image-parameter-settings-popup').matches(':popover-open')||toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()");
    await app.waitFor("document.querySelector('#image-parameter-panel [data-parameter-group=reference]')?.checkVisibility()===true");
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
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

test('reference gallery uses square thumbnails with overlay numbers and preserves complete source batches', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await populateSources(app);
        await openReferences(app);
        const layout = await app.evaluate("(()=>{const gallery=document.querySelector('#target-reference-sources .image-reference-grid'),rows=[...gallery.querySelectorAll('.image-reference-group')],tiles=[...gallery.querySelectorAll('.image-reference-thumbnail')];return {tops:tiles.map(tile=>tile.getBoundingClientRect().top),height:gallery.clientHeight,overflow:gallery.scrollWidth>gallery.clientWidth+1,slots:rows.map(row=>row.querySelectorAll('[data-source-image-index]').length),nodeHeight:document.getElementById('target').offsetHeight}})()");
        assert.equal(layout.tops[0], layout.tops[1], 'thumbnails share a compact grid row');
        assert.equal(await app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-thumbnail')].every(tile=>{const r=tile.getBoundingClientRect(),n=tile.querySelector('.image-reference-number').getBoundingClientRect();return r.width===64&&r.height===64&&n.right<r.right&&n.bottom<r.bottom&&n.top>r.top+r.height/2})"), true, 'every thumbnail is square and its number floats inside the lower-right corner');
        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-heading, #target-reference-sources .image-reference-tools, #target-reference-sources .image-reference-source-name').length"), 0, 'source names and toolbars do not take visible space');
        assert.ok(layout.height <= 212);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.slots, [1, 1, 6]);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6', '7', '8']);

        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-details').length"), 0);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='single-a').imageDescription)"), description, 'source descriptions are retained as data');
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' });
        assert.equal(await app.evaluate("(()=>{const gallery=document.querySelector('#target-reference-sources .image-reference-grid');return gallery.scrollWidth<=gallery.clientWidth+1&&gallery.clientHeight<=212})()"), true,
            'reducing the editor width wraps square thumbnails without overflowing or losing batch slots');
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

test('thumbnail hover actions and native drag reorder or disconnect a whole source with undo', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await populateSources(app);
        await openReferences(app);
        const point = selector => app.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        const click = async position => {
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
        };
        const batchTile = '[data-reference-connection=edge-batch] .image-reference-thumbnail';
        const close = '[data-reference-connection=edge-batch] .image-reference-disconnect';
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        assert.equal(await app.evaluate(`getComputedStyle(document.querySelector('${close}')).opacity`), '0', 'disconnect is hidden at rest');
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(batchTile) });
        assert.equal(await app.evaluate(`getComputedStyle(document.querySelector('${close}')).opacity`), '1', 'hover reveals the close button on the thumbnail');

        let dragData;
        const unsubscribe = app.onProtocolEvent(event => { if (event.method === 'Input.dragIntercepted') dragData = event.params.data; });
        await app.send('Input.setInterceptDrags', { enabled: true });
        try {
            const start = await point(batchTile), end = await point('[data-reference-connection=edge-single-a] .image-reference-thumbnail');
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x - 12, y: start.y, button: 'left', buttons: 1 });
            await app.waitFor(() => Boolean(dragData));
            for (const type of ['dragEnter', 'dragOver', 'drop']) await app.send('Input.dispatchDragEvent', { type, ...end, data: dragData });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
        } finally { unsubscribe(); await app.send('Input.setInterceptDrags', { enabled: false }); }
        const order = () => app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-group')].map(group=>group.dataset.referenceConnection)");
        assert.deepEqual(await order(), ['edge-batch', 'edge-single-a', 'edge-single-b'], 'dragging one thumbnail moves its complete source batch');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('[data-reference-connection=edge-batch] [data-reference-number]')].map(tile=>tile.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6']);
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay')===null"), true, 'dragging does not open the preview');

        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(batchTile) });
        await click(await point(close));
        assert.deepEqual(await order(), ['edge-single-a', 'edge-single-b']);
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay')===null"), true, 'disconnect click does not bubble into preview');
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>!d.value.connections.some(c=>c.id==='edge-batch')&&d.value.connections.some(c=>c.id==='shared-batch')&&d.value.nodes.find(n=>n.id==='batch').mediaAssetKeys.length===6)");
        await app.evaluate("document.getElementById('canvas-container').focus()");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
        await app.waitFor("document.querySelectorAll('#target-reference-sources [data-reference-number]').length===8");
        assert.deepEqual(await order(), ['edge-batch', 'edge-single-a', 'edge-single-b'], 'undo restores the batch and its prior order');
        assert.equal(await app.evaluate('window.referenceGalleryRequests'), 8, 'sorting, disconnect and undo do not regenerate images');
    });
});
