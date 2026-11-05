import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const originals = await Promise.all(['red', 'blue', 'green'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'batch-source', type: 'ImageGenerate', x: 60, y: 70, apiConfigId: 'image', providerId: 'p', prompt: 'preview batch navigation', generationCount: 3 },
        { id: 'batch-preview', type: 'ImagePreview', x: 440, y: 70, width: 310, height: 360, userResized: true },
        { id: 'batch-output', type: 'ImagePreview', x: 820, y: 70 }
    ],
    connections: [
        { id: 'source-preview', from: { nodeId: 'batch-source', port: 'image' }, to: { nodeId: 'batch-preview', port: 'image' }, type: 'image' },
        { id: 'preview-output', from: { nodeId: 'batch-preview', port: 'image' }, to: { nodeId: 'batch-output', port: 'image' }, type: 'image' }
    ]
};

async function assertOriginalAspect(app) {
    await app.waitFor("(()=>{const surface=document.querySelector('#batch-preview .node-media-aspect-surface'),img=surface?.querySelector('img');if(!img?.naturalWidth)return false;const r=surface.getBoundingClientRect();return r.width>0&&Math.abs(r.width/r.height-img.naturalWidth/img.naturalHeight)<0.02})()");
    assert.equal(await app.evaluate("document.getElementById('batch-preview').offsetWidth"), 310, 'aspect updates retain the chosen card width');
}

async function controlled(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.previewBatchRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy'&&options.body&&typeof JSON.parse(options.body).prompt==='string'){
            previewBatchRequests.push(JSON.parse(options.body));const images=${JSON.stringify(originals)};
            return new Response(JSON.stringify({data:[{b64_json:images[(previewBatchRequests.length-1)%images.length].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});
        }return nativeFetch(url,options);
    };` });
    await reloadAppBrowser(app);
}

const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const previewOwners = app => app.evaluate("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(response=>response.json())).value;const owners=(await fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(saved.activeWorkflowId)).then(response=>response.json())).owners;return owners.filter(owner=>owner.ownerId==='batch-preview').map(({ownerType,ownerId,assetKeys,tombstoned})=>({ownerType,ownerId,assetKeys,tombstoned})).sort((left,right)=>left.ownerType.localeCompare(right.ownerType))})()");
async function run(app) {
    await app.evaluate("document.getElementById('btn-run').click()");
    await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='batch-source')?.mediaAssetKeys?.length===3)");
    await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='batch-preview')?.mediaAssetKeys?.length===3)");
    await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter')?.textContent.endsWith('/3')");
    await app.waitFor("document.getElementById('btn-stop').disabled");
}
async function openBatch(app) {
    await app.evaluate("document.querySelector('#batch-preview-preview .image-save-preview-counter').click()");
    await app.waitFor("document.querySelectorAll('#batch-preview-preview [data-preview-batch-index]').length===3 && !document.querySelector('#batch-preview-preview .image-node-result-batch').hidden");
}

test('a preview can browse its complete batch with thumbnails and original aspect ratios while preserving the whole output and saved position', { timeout: 45000 }, async () => {
    await withAppBrowser(configuration, async app => {
        await controlled(app); await run(app);
        const before = await saved(app);
        const beforeOwners = await previewOwners(app);
        assert.equal(await app.evaluate("document.querySelector('#batch-preview-preview .image-save-preview-counter').tagName"), 'BUTTON');
        await openBatch(app);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('#batch-preview-preview [data-preview-batch-index]')).map(item=>Number(item.dataset.previewBatchIndex))"), [0, 1, 2]);
        await app.waitFor("[...document.querySelectorAll('#batch-preview-preview [data-preview-batch-index] img')].length===3 && [...document.querySelectorAll('#batch-preview-preview [data-preview-batch-index] img')].every(image=>image.naturalWidth>0)");
        assert.ok(await app.evaluate("[...document.querySelectorAll('#batch-preview-preview [data-preview-batch-index] img')].every(image=>image.naturalWidth<=480 && image.naturalHeight<=480)"));
        await app.evaluate("document.querySelector('#batch-preview-preview [data-preview-batch-index=\"2\"]').click()");
        await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter').textContent==='3/3'");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='batch-preview')?.imagePreviewIndex===2)");
        const selected = (await saved(app)).nodes.find(node => node.id === 'batch-preview');
        assert.deepEqual({ ...selected, imagePreviewIndex: before.nodes.find(node => node.id === 'batch-preview').imagePreviewIndex }, before.nodes.find(node => node.id === 'batch-preview'), 'selecting a batch item only changes the stored browsing index');
        await app.evaluate("document.querySelector('#batch-preview-preview [data-preview-batch-index=\"0\"]').click()");
        await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter').textContent==='1/3'");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='batch-preview')?.imagePreviewIndex===0)");
        await assertOriginalAspect(app);
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
        const after = await saved(app);
        assert.deepEqual(after.nodes.find(node => node.id === 'batch-source').mediaAssetKeys, before.nodes.find(node => node.id === 'batch-source').mediaAssetKeys);
        assert.deepEqual(after.nodes.find(node => node.id === 'batch-preview').mediaAssetKeys, before.nodes.find(node => node.id === 'batch-preview').mediaAssetKeys, 'browsing retains the existing media identities');
        assert.deepEqual(await previewOwners(app), beforeOwners, 'batch navigation adds no media owner or reference');
        assert.deepEqual(after.connections, configuration.connections);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.querySelector('#batch-preview-preview .image-node-result-batch').hidden");
        assert.equal(await app.evaluate("document.activeElement===document.querySelector('#batch-preview-preview .image-save-preview-counter')"), true);

        await app.evaluate("document.getElementById('batch-output').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:900,clientY:230}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:900,clientY:230}));document.getElementById('batch-output').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:900,clientY:230}));document.getElementById('context-menu-run-selected').click()");
        await app.waitFor("document.querySelector('#batch-output-preview .image-save-preview-counter')?.textContent.endsWith('/3')");
        assert.equal(await app.evaluate('previewBatchRequests.length'), 3, 'browsing and running the downstream preview reuse the full source batch');

        await reloadAppBrowser(app);
        await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter')?.textContent==='1/3'");
        await assertOriginalAspect(app);
        await app.evaluate("document.getElementById('batch-preview-fullscreen').click()");
        await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await app.evaluate(`document.querySelector('.fullscreen-overlay img').src===${JSON.stringify(originals[0])}`), true, 'the saved first position opens the first original');
    });
});

test('a preview retains a missing first batch position and selects the second original without shifting or recovering media', { timeout: 45000 }, async () => {
    await withAppBrowser(configuration, async app => {
        await controlled(app); await run(app);
        const before = await saved(app);
        const sourceKeys = before.nodes.find(node => node.id === 'batch-source').mediaAssetKeys;
        const previewKeys = before.nodes.find(node => node.id === 'batch-preview').mediaAssetKeys;
        const digest = createHash('sha256').update(Buffer.from(originals[0].split(',')[1], 'base64')).digest('hex');
        await unlink(join(app.server.dataDir, 'assets', digest.slice(0, 2), digest + '.png'));
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("Boolean(document.querySelector('#batch-preview-preview > img'))"), false, 'a missing first original stays a placeholder instead of displaying the second image');
        await openBatch(app);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('#batch-preview-preview [data-preview-batch-index]')).map(item=>Number(item.dataset.previewBatchIndex))"), [0, 1, 2]);
        await app.waitFor("document.querySelector('#batch-preview-preview [data-preview-batch-index=\"0\"]').textContent.includes('原图缺失')");
        await app.waitFor("document.querySelector('#batch-preview-preview [data-preview-batch-index=\"1\"] img')?.naturalWidth>0");
        await app.evaluate("document.querySelector('#batch-preview-preview [data-preview-batch-index=\"1\"]').click()");
        await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter').textContent==='2/3'");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='batch-preview')?.imagePreviewIndex===1)");
        await assertOriginalAspect(app);
        await app.evaluate("document.querySelector('#batch-preview-preview [aria-label=\"关闭整批导航\"]').click()");
        assert.equal(await app.evaluate("document.activeElement===document.querySelector('#batch-preview-preview .image-save-preview-counter')"), true);
        await app.evaluate("document.getElementById('batch-preview-fullscreen').click()");
        await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await app.evaluate(`document.querySelector('.fullscreen-overlay img').src===${JSON.stringify(originals[1])}`), true, 'the second position opens the second original even when the first is missing');
        const after = await saved(app);
        assert.deepEqual(after.nodes.find(node => node.id === 'batch-source').mediaAssetKeys, sourceKeys);
        assert.deepEqual(after.nodes.find(node => node.id === 'batch-preview').mediaAssetKeys, previewKeys);
        assert.equal(await app.evaluate('previewBatchRequests.length'), 0, 'a missing original is never regenerated or recovered while browsing');
        await reloadAppBrowser(app);
        await app.waitFor("document.querySelector('#batch-preview-preview .image-save-preview-counter')?.textContent==='2/3'");
        await app.evaluate("document.getElementById('batch-preview-fullscreen').click()");
        await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await app.evaluate(`document.querySelector('.fullscreen-overlay img').src===${JSON.stringify(originals[1])}`), true, 'reopening retains the selected durable position');
    });
});

test('the public batch navigation reads visible thumbnails only and discards reads from a changed batch or replaced node', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        // The exported factory's callbacks are its public media boundary. The
        // fixture never reads application state or the thumbnail cache.
        await app.evaluate(`(async()=>{
            const {createImagePreviewBatchNavigation}=await import('/js/nodes/image-preview-batch-navigation.js');
            const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
            const host=document.createElement('div');host.id='public-preview-batch';host.className='preview-container';
            host.style.cssText='position:fixed;left:20px;top:80px;width:280px;height:180px;z-index:9999;background:var(--panel-bg)';document.body.append(host);
            const node={id:'public-preview-node',type:'ImagePreview',imagePreviewIndex:0,data:{mediaAssetKeys:Array.from({length:64},(_,index)=>'media:public-'+index),imageCount:64}};
            const state={nodes:new Map([[node.id,node]])};
            const contract={host,node,state,readRequests:[],thumbnailSources:[],deferFirst:true};
            const navigation=createImagePreviewBatchNavigation({state,documentRef:document,windowRef:window,
                readOriginalAt:async(target,index,assetKey)=>{contract.readRequests.push({index,assetKey});if(target.data.imageList)return target.data.imageList[index];if(index===0&&contract.deferFirst)return new Promise(resolve=>contract.resolveFirst=()=>resolve(${JSON.stringify(originals[0])}));return pixel},
                createThumbnail:async source=>{contract.thumbnailSources.push(source===${JSON.stringify(originals[0])}?'first':'other');return pixel},
                onSelect:async(target,index)=>{target.imagePreviewIndex=index;navigation.render(target,host)}});
            contract.navigation=navigation;window.previewBatchContract=contract;navigation.render(node,host);
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        assert.equal(await app.evaluate('previewBatchContract.readRequests.length'), 0, 'a closed batch does not read any originals');
        await app.evaluate("document.querySelector('#public-preview-batch .image-save-preview-counter').click()");
        await app.waitFor('Boolean(previewBatchContract.resolveFirst) && previewBatchContract.readRequests.length>1');
        assert.ok(await app.evaluate('previewBatchContract.readRequests.length<64'), 'offscreen slots do not start original reads');
        assert.equal(await app.evaluate('previewBatchContract.readRequests.some(request=>request.index===63)'), false);

        await app.evaluate("previewBatchContract.node.data.mediaAssetKeys[1]='media:replacement';previewBatchContract.resolveFirst()");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate("Boolean(document.querySelector('#public-preview-batch [data-preview-batch-index=\"0\"] img'))"), false, 'changing another batch position invalidates the pending first read');
        assert.equal(await app.evaluate("previewBatchContract.thumbnailSources.includes('first')"), false, 'stale original reads are discarded before thumbnail generation');

        await app.evaluate("previewBatchContract.resolveFirst=null;previewBatchContract.navigation.render(previewBatchContract.node,previewBatchContract.host);document.querySelector('#public-preview-batch .image-save-preview-counter').click()");
        await app.waitFor('Boolean(previewBatchContract.resolveFirst)');
        await app.evaluate("previewBatchContract.replacement={...previewBatchContract.node};previewBatchContract.state.nodes.set(previewBatchContract.node.id,previewBatchContract.replacement);previewBatchContract.resolveFirst()");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate("Boolean(document.querySelector('#public-preview-batch [data-preview-batch-index=\"0\"] img'))"), false, 'a replacement node with the same ID cannot receive the previous node read');

        await app.evaluate("previewBatchContract.navigation.destroy(previewBatchContract.node);previewBatchContract.node=previewBatchContract.replacement;previewBatchContract.deferFirst=false;previewBatchContract.navigation.render(previewBatchContract.node,previewBatchContract.host);document.querySelector('#public-preview-batch .image-save-preview-counter').click();document.querySelector('#public-preview-batch .image-node-result-batch-grid').scrollTo({top:100000})");
        await app.waitFor("document.querySelector('#public-preview-batch [data-preview-batch-index=\"63\"] img')?.naturalWidth>0");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.querySelector('#public-preview-batch .image-node-result-batch').hidden");
        assert.equal(await app.evaluate("document.activeElement===document.querySelector('#public-preview-batch .image-save-preview-counter')"), true);
        await app.evaluate("previewBatchContract.navigation.destroy(previewBatchContract.node);previewBatchContract.readCountAtDestroy=previewBatchContract.readRequests.length");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate('previewBatchContract.readRequests.length'), await app.evaluate('previewBatchContract.readCountAtDestroy'));
        assert.equal(await app.evaluate("Boolean(document.querySelector('#public-preview-batch .image-node-result-batch'))"), false);

        await app.evaluate(`(()=>{const contract=previewBatchContract;contract.node={id:'public-preview-node',type:'ImagePreview',imagePreviewIndex:0,data:{imageAssetKey:'legacy-preview',imageCount:2,imageList:[${JSON.stringify(originals[0])},${JSON.stringify(originals[0])}]}};contract.state.nodes.set(contract.node.id,contract.node);contract.navigation.render(contract.node,contract.host);document.querySelector('#public-preview-batch .image-save-preview-counter').click()})()`);
        await app.waitFor("document.querySelectorAll('#public-preview-batch [data-preview-batch-index] img').length===2");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.evaluate(`previewBatchContract.readCountBeforeReopen=previewBatchContract.readRequests.length;previewBatchContract.node.data.imageList[0]=${JSON.stringify(originals[1])};document.querySelector('#public-preview-batch .image-save-preview-counter').click()`);
        await app.waitFor('previewBatchContract.readRequests.length>previewBatchContract.readCountBeforeReopen');
        await app.waitFor("document.querySelectorAll('#public-preview-batch [data-preview-batch-index] img').length===2");
        assert.deepEqual(await app.evaluate('previewBatchContract.thumbnailSources.slice(-2).sort()'), ['first', 'other'], 'reopening a legacy batch reads its current original instead of retaining the previous source');
        await app.evaluate('previewBatchContract.navigation.destroy(previewBatchContract.node)');
    });
});
