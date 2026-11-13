import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { configuration, key, nativeClick, openParameters, originals, saved } from './helpers/image-first-integrated-fixture.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const longTitle = '第一组参考来源的完整长标题，包含主体、光线与构图要求，展开之后必须完整阅读，不能只依赖鼠标悬停。';
const description = '保留主体的轮廓与连接结构。\n冷色环境光，背景留白，所有细节按原图保持。'.repeat(6);
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
        { id: 'gemini-image', modelId: 'gemini-2.5-flash-image', name: '受控 Gemini 图片', protocol: 'google', taskType: 'image', providerIds: ['p'] }
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
    await app.waitFor("document.querySelector('#image-parameter-panel .image-parameter-references')?.checkVisibility()===true");
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
        assert.ok(layout.tops.every(top => top === layout.tops[0]), 'all thumbnails stay on a single compact row');
        assert.ok(await app.evaluate("(()=>{const refs=document.querySelector('#image-parameter-panel .image-parameter-references'),prompt=document.getElementById('target-prompt');return refs.getBoundingClientRect().bottom<=prompt.getBoundingClientRect().top&&!refs.querySelector('.node-section-label')&&!refs.closest('.image-parameter-settings-popup')&&!document.querySelector('.image-parameter-settings-popup:popover-open')})()"), 'references are visible above the prompt without opening More or adding a heading');
        assert.equal(await app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-thumbnail')].every(tile=>{const r=tile.getBoundingClientRect(),n=tile.querySelector('.image-reference-number').getBoundingClientRect();return r.width===60&&r.height===60&&n.right<r.right&&n.bottom<r.bottom&&n.top>r.top+r.height/2})"), true, 'every thumbnail is square and its number floats inside the lower-right corner');
        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-heading, #target-reference-sources .image-reference-tools, #target-reference-sources .image-reference-source-name').length"), 0, 'source names and toolbars do not take visible space');
        assert.ok(layout.height <= 68);
        assert.equal(layout.overflow, false);
        assert.deepEqual(layout.slots, [1, 1, 6]);
        const spacing = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),r=p.getBoundingClientRect(),thumb=p.querySelector('.image-reference-thumbnail').getBoundingClientRect(),prompt=p.querySelector('.image-node-prompt-field textarea').getBoundingClientRect(),controls=[...p.querySelectorAll('.image-parameter-settings-entry,.image-parameter-model-entry,.image-parameter-more-entry,.generation-count-control,[data-parameter-action=generate]')].map(el=>el.getBoundingClientRect());return [thumb.top-r.top,thumb.left-r.left,prompt.top-thumb.bottom,controls[0].top-prompt.bottom,prompt.left-r.left,r.right-prompt.right,r.bottom-controls.at(-1).bottom,...controls.slice(1).map((box,index)=>box.left-controls[index].right)]})()");
        assert.ok(spacing.every(gap=>Math.abs(gap-6)<0.5), 'visible edges share one spacing, including reference wrappers and nested footer groups: '+JSON.stringify(spacing));
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-number]')].map(item=>item.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6', '7', '8']);
        assert.equal(await app.evaluate("document.querySelector('#target-reference-sources .image-reference-grid').title"), '参考图 8 / 16 张');
        const selectModel = id => app.evaluate(`(()=>{const field=document.getElementById('target-apiconfig');field.value=${JSON.stringify(id)};field.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await selectModel('gemini-image');
        assert.equal(await app.evaluate("document.querySelector('#target-reference-sources .image-reference-capacity')?.textContent"),
            '参考图 8 / 3 张 · 已超出当前模型上限');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources [data-reference-connection]')].map(row=>row.dataset.referenceConnection)"),
            ['edge-single-a', 'edge-single-b', 'edge-batch']);
        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources [data-reference-number]').length"), 8);
        await selectModel('image');
        assert.equal(await app.evaluate("document.querySelector('#target-reference-sources .image-reference-capacity')===null"), true);

        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-details').length"), 0);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='single-a').imageDescription)"), description, 'source descriptions are retained as data');
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home' });
        assert.equal(await app.evaluate("(()=>{const gallery=document.querySelector('#target-reference-sources .image-reference-grid');return gallery.scrollWidth>gallery.clientWidth+1&&gallery.clientHeight<=68})()"), true,
            'reducing the editor width keeps one horizontal strip without losing batch slots');
        assert.equal(await app.evaluate("document.getElementById('target').offsetHeight"), layout.nodeHeight, 'gallery edits never change the image card height');
        await app.evaluate("(()=>{for(let index=0;index<3;index++)document.querySelector('#target-reference-sources .image-reference-group .image-reference-disconnect').click()})()");
        await app.waitFor("document.querySelector('#image-parameter-panel .image-parameter-references').hidden");
        assert.ok(await app.evaluate("document.getElementById('target-prompt').checkVisibility()"), 'the empty strip collapses while the prompt remains available');
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.find(n=>n.id==='batch').mediaAssetKeys.length)"), 6, 'disconnecting references does not remove original source images');
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

        const drag = async (fromSelector, toSelector, side) => {
            let dragData;
            const unsubscribe = app.onProtocolEvent(event => { if (event.method === 'Input.dragIntercepted') dragData = event.params.data; });
            await app.send('Input.setInterceptDrags', { enabled: true });
            try {
                const start = await point(fromSelector), end = await point(toSelector);
                await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
                await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
                await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x - 12, y: start.y, button: 'left', buttons: 1 });
                await app.waitFor(() => Boolean(dragData));
                for (const type of ['dragEnter', 'dragOver']) await app.send('Input.dispatchDragEvent', { type, ...end, data: dragData });
                assert.equal(await app.evaluate("document.querySelector('#target-reference-sources .is-drop-target')?.dataset.dropSide"), side, 'the insertion marker matches the actual whole-source destination');
            assert.equal(await app.evaluate("[...document.querySelectorAll('#target-reference-sources .is-drop-target .image-reference-item')].filter(item=>getComputedStyle(item,'::after').content!=='none').length"), 1, 'only the destination boundary is marked');
                await app.send('Input.dispatchDragEvent', { type: 'drop', ...end, data: dragData });
                await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
            } finally { unsubscribe(); await app.send('Input.setInterceptDrags', { enabled: false }); }
        };
        await drag(batchTile, '[data-reference-connection=edge-single-a] .image-reference-thumbnail', 'before');
        const order = () => app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-group')].map(group=>group.dataset.referenceConnection)");
        assert.deepEqual(await order(), ['edge-batch', 'edge-single-a', 'edge-single-b'], 'dragging one thumbnail moves its complete source batch');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('[data-reference-connection=edge-batch] [data-reference-number]')].map(tile=>tile.dataset.referenceNumber)"), ['1', '2', '3', '4', '5', '6']);
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay')===null"), true, 'dragging does not open the preview');

        await drag('[data-reference-connection=edge-single-a] .image-reference-thumbnail', '[data-reference-connection=edge-single-b] .image-reference-thumbnail', 'after');
        assert.deepEqual(await order(), ['edge-batch', 'edge-single-b', 'edge-single-a'], 'a forward move inserts after the marked source');

        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(batchTile) });
        await click(await point(close));
        assert.deepEqual(await order(), ['edge-single-b', 'edge-single-a']);
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay')===null"), true, 'disconnect click does not bubble into preview');
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>!d.value.connections.some(c=>c.id==='edge-batch')&&d.value.connections.some(c=>c.id==='shared-batch')&&d.value.nodes.find(n=>n.id==='batch').mediaAssetKeys.length===6)");
        await app.evaluate("document.getElementById('canvas-container').focus()");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
        await app.waitFor("document.querySelectorAll('#target-reference-sources [data-reference-number]').length===8");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('已撤回'))");
        assert.deepEqual(await order(), ['edge-batch', 'edge-single-b', 'edge-single-a'], 'undo restores the batch and its prior order');
        await app.waitFor(`document.querySelector('${close}')?.disabled===false &&
            document.querySelector('[data-reference-connection=edge-batch] .image-reference-item')?.draggable===true`);
        await openReferences(app);
        await app.evaluate(`document.querySelector('${batchTile}').focus({preventScroll:true})`);
        await key(app, 'ArrowRight', 'ArrowRight', 1);
        assert.deepEqual(await order(), ['edge-single-b', 'edge-batch', 'edge-single-a'], 'the restored sources can be reordered immediately');
        assert.equal(await app.evaluate('window.referenceGalleryRequests'), 8, 'sorting, disconnect and undo do not regenerate images');
    });
});

test('commerce, chat and video reference galleries edit their own sources without changing fixed video frames', { timeout: 45000 }, async () => {
    const targets = ['commerce-target', 'chat-target', 'video-target'];
    const nodes = [
        { id: 'red', type: 'ImageImport', x: 40, y: 100 },
        { id: 'blue', type: 'ImageImport', x: 40, y: 320 },
        { id: 'first', type: 'ImageImport', x: 40, y: 540 },
        { id: 'last', type: 'ImageImport', x: 40, y: 760 },
        { id: 'commerce-target', type: 'ECommerceImageSet', x: 360, y: 100 },
        { id: 'chat-target', type: 'TextChat', x: 760, y: 100, apiConfigId: 'chat', providerId: 'p' },
        { id: 'video-target', type: 'VideoGenerate', x: 760, y: 540, apiConfigId: 'video', providerId: 'p' }
    ];
    const edge = (source, target, port, order) => ({ id: `${target}-${source}`, type: 'image',
        from: { nodeId: source, port: 'image' }, to: { nodeId: target, port }, order });
    const fixedFrames = [edge('first', 'video-target', 'image_1', 0), edge('last', 'video-target', 'image_2', 1)];
    const connections = [...fixedFrames, ...targets.flatMap(target => [
        edge('blue', target, 'referenceImages', 7), edge('red', target, 'referenceImages', 2)
    ])];
    const models = [...configuration.models, { id: 'video-unsupported', modelId: 'unmatched-video-model', name: '未匹配视频模型',
        protocol: 'async-video-api', taskType: 'video', providerIds: ['p'] }];
    const gallery = target => `#${target}-reference-sources`;
    const thumbnail = (target, source) => `${gallery(target)} [data-reference-connection=${target}-${source}] .image-reference-thumbnail`;
    const waitForOrder = (app, target, sources) => app.waitFor(`(() => {
        const groups = Array.from(document.querySelectorAll('${gallery(target)} .image-reference-group'));
        const expected = ${JSON.stringify(sources.map(source => `${target}-${source}`))};
        return groups.length === expected.length && groups.every((group, index) => group.dataset.referenceConnection === expected[index]);
    })()`);

    await withAppBrowser({ ...configuration, models, nodes, connections }, async app => {
        await uploadImageOriginal(app, 'red', originals[0]);
        await uploadImageOriginal(app, 'blue', originals[1]);
        await openParameters(app, 'commerce-target');
        await app.waitFor("document.querySelector('#image-parameter-panel[data-mode=docked] #commerce-target-reference-sources')?.checkVisibility()");

        for (const target of targets) {
            await waitForOrder(app, target, ['red', 'blue']);
            assert.ok(await app.evaluate(`document.querySelector('${gallery(target)}')?.checkVisibility()`));
            assert.deepEqual(await app.evaluate(`Array.from(document.querySelectorAll('${gallery(target)} [data-reference-number]'), item => item.dataset.referenceNumber)`), ['1', '2']);
        }

        const commerceThumbnail = thumbnail('commerce-target', 'red');
        await nativeClick(app, commerceThumbnail);
        const preview = '.fullscreen-overlay .fullscreen-img-wrapper img';
        await app.waitFor(`document.querySelector('${preview}')?.src===${JSON.stringify(originals[0])}`);
        await key(app, 'Escape');
        await app.waitFor(`!document.querySelector('.fullscreen-overlay') && document.activeElement===document.querySelector('${commerceThumbnail}')`);
        const connectionDetails = '#image-parameter-panel .commerce-image-set-reference-details';
        await nativeClick(app, `${connectionDetails} > summary`);
        assert.ok(await app.evaluate(`document.querySelector('${connectionDetails} .image-input-more > summary')?.checkVisibility()`));
        await nativeClick(app, `${connectionDetails} > summary`);

        for (const target of targets) {
            await app.evaluate(`document.querySelector('${thumbnail(target, 'blue')}').focus({preventScroll:true})`);
            await key(app, 'ArrowLeft', 'ArrowLeft', 1);
            await waitForOrder(app, target, ['blue', 'red']);
        }

        await app.evaluate(`document.querySelector('${thumbnail('video-target', 'red')}').focus({preventScroll:true})`);
        await key(app, 'Delete');
        await waitForOrder(app, 'video-target', ['blue']);
        await app.waitFor(async () => (await saved(app)).connections?.length === connections.length - 1, 7500, { interval: 200 });
        const persisted = await saved(app);
        assert.deepEqual(persisted.connections.map(item => item.id).sort(),
            connections.filter(item => item.id !== 'video-target-red').map(item => item.id).sort());
        assert.deepEqual(persisted.connections.filter(item => fixedFrames.some(frame => frame.id === item.id)).map(item => item.to.port).sort(), ['image_1', 'image_2']);
        for (const target of ['commerce-target', 'chat-target']) {
            assert.deepEqual(persisted.connections.filter(item => item.to.nodeId === target).sort((a, b) => a.order - b.order).map(item => item.from.nodeId), ['blue', 'red']);
        }
        const changeVideoModel = modelId => app.evaluate(`(() => {
            const model = document.getElementById('video-target-apiconfig');
            model.value = ${JSON.stringify(modelId)};
            model.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await changeVideoModel('video-unsupported');
        await app.waitFor(`document.querySelector('${gallery('video-target')}').textContent.includes('当前视频模型不支持参考图')`);
        assert.equal(await app.evaluate(`document.querySelectorAll('${gallery('video-target')} [data-reference-number]').length`), 0);
        assert.equal(await app.evaluate(`document.querySelector('${gallery('video-target')} .image-reference-disconnect').disabled`), false);
        await changeVideoModel('video');
        await app.waitFor(`document.querySelector('${thumbnail('video-target', 'blue')}').dataset.referenceNumber==='1'`);
    });
});
