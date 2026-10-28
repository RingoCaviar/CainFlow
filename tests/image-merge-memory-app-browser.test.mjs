import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { readFile } from 'node:fs/promises';

const original = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');

test('the public Merge media view restores one current original, releases it offscreen, and preserves missing and complete output slots', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }], nodes: [], connections: [] }, async app => {
        // Public media-controller boundary in the real browser; this is a
        // targeted loading-budget contract, separate from full workflow tests.
        await app.evaluate(`(async()=>{const {createMediaControllerApi}=await import('/js/features/media/media-controller.js');
            const card=document.createElement('div');card.id='memory-merge';card.className='node';card.innerHTML='<div id="memory-merge-merge-preview" style="width:280px;height:220px"></div>';document.body.append(card);
            const node={id:card.id,type:'ImageMerge',x:10,y:10,imagePreviewIndex:17,el:card,data:{mediaAssetKeys:Array.from({length:64},(_,i)=>'media:slot-'+i),imageCount:64,imageAssetReady:true}};
            const state={nodes:new Map([[node.id,node]]),connections:[],canvas:{x:0,y:0,zoom:1},selectedNodes:new Set(),runningNodeIds:new Set()};window.mergeReads=[];
            const api=createMediaControllerApi({state,getNodeById:id=>state.nodes.get(id),documentRef:document,windowRef:window,
                getActiveWorkflowId:()=> 'memory-workflow',getImageAsset:async key=>{mergeReads.push(key);return key==='media:slot-19'?null:${JSON.stringify(original)}},
                getImageResolution:async()=> '32×32',scheduleSave(){},showToast(){},onMediaIntegrityChanged(){}});
            window.mergeMemoryContract={node,state,api};api.renderImageMergePreview(node.id,[]);
        })()`);
        await app.waitFor("document.querySelector('#memory-merge-merge-preview img')?.naturalWidth>0");
        assert.deepEqual(await app.evaluate('mergeReads'), ['media:slot-17']);
        assert.equal(await app.evaluate('mergeMemoryContract.node.data.imageList'), undefined, 'displaying one slot never publishes a truncated canonical batch');
        await app.evaluate('mergeMemoryContract.api.renderImageMergePreview(mergeMemoryContract.node.id,[])');
        assert.equal(await app.evaluate('mergeReads.length'), 1, 'presentation refresh retains only the current slot cache');
        const soft = await app.evaluate(`mergeMemoryContract.node.data.imageList=Array(64).fill(${JSON.stringify(original)});mergeMemoryContract.api.renderImageMergePreview(mergeMemoryContract.node.id,mergeMemoryContract.node.data.imageList);mergeMemoryContract.api.sweepDisplayImageMemory()`);
        assert.equal(soft.softReleased, 1);
        await app.evaluate("document.querySelector('#memory-merge-merge-preview .image-save-preview-counter').click()");
        await app.waitFor("document.querySelector('#memory-merge-merge-preview .image-preview-batch-navigation')?.hidden===false");
        await app.evaluate("document.querySelector('#memory-merge-merge-preview .image-save-preview-counter').click();mergeReads=[]");
        const released = await app.evaluate('mergeMemoryContract.node.x=6000;mergeMemoryContract.api.sweepDisplayImageMemory()');
        assert.equal(released.released, 1);
        assert.equal(await app.evaluate("document.querySelectorAll('#memory-merge-merge-preview img').length"), 0);
        const restored = await app.evaluate('mergeMemoryContract.node.x=10;mergeMemoryContract.api.sweepDisplayImageMemory()');
        assert.equal(restored.restored, 1); assert.deepEqual(await app.evaluate('mergeReads'), ['media:slot-17']);
        await app.evaluate('mergeMemoryContract.node.imagePreviewIndex=19;mergeMemoryContract.api.renderImageMergePreview(mergeMemoryContract.node.id,[])');
        await app.waitFor("!!document.querySelector('#memory-merge-merge-preview .missing-media-asset-placeholder[data-position=\"19\"]')");
        assert.deepEqual(await app.evaluate('mergeReads'), ['media:slot-17', 'media:slot-19']);
        assert.equal(await app.evaluate('mergeMemoryContract.node.data.mediaAssetKeys.length'), 64);
        assert.equal(await app.evaluate('mergeMemoryContract.node.imagePreviewIndex'), 19);
        const context = await app.evaluate('mergeMemoryContract.api.getNodeFullscreenImageContext(mergeMemoryContract.node.id)');
        assert.equal(context.images.length, 64); assert.equal(context.images[19], ''); assert.equal(context.images[20], original);
        assert.equal(context.index, 19, 'an explicit complete-original request preserves the missing current position');
    });
});

test('opening a saved 64-original Merge reads only its selected local asset and does not rewrite the workflow', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }], nodes: [], connections: [] }, async app => {
        const keys = await app.evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const context=canvas.getContext('2d'),keys=[];
            for(let index=0;index<64;index++){context.fillStyle='rgb('+index+','+(index*3%256)+','+(index*7%256)+')';context.fillRect(0,0,16,16);
                const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
                const response=await fetch('/api/storage/media-assets',{method:'PUT',headers:{'Content-Type':'image/png','X-CainFlow-Media-Owner-Type':'test-fixture','X-CainFlow-Media-Owner-Id':'merge-budget'},body:blob});
                if(!response.ok)throw new Error(await response.text());keys.push((await response.json()).asset.asset_key);}
            return keys;})()`);
        assert.equal(new Set(keys).size, 64);
        const workflow = { workflowId: 'merge-budget', canvas: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'durable-merge', type: 'ImageMerge', x: 60, y: 130,
            width: 280, height: 220, userResized: true, inputCount: 1, imageCount: 64, imagePreviewIndex: 17, imageAssetReady: true, mediaAssetKeys: keys }], connections: [] };
        await app.evaluate(`fetch('/api/workflows/Merge%20Budget',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(workflow))}}).then(response=>{if(!response.ok)throw new Error('fixture workflow write failed')})`);
        const before = await app.evaluate("fetch('/api/workflows/Merge%20Budget').then(response=>response.text())");
        await app.evaluate("window.mergeAssetReads=[];const mergeNativeFetch=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/api/storage/assets/'))mergeAssetReads.push(String(url));return mergeNativeFetch(url,options)};document.getElementById('btn-toggle-workflow').click()");
        await app.waitFor("!!document.querySelector('.workflow-item[data-name=\"Merge Budget\"]')");
        await app.evaluate("document.querySelector('.workflow-item[data-name=\"Merge Budget\"]').click()");
        await app.waitFor("document.querySelector('#durable-merge-merge-preview img')?.naturalWidth>0");
        const reads = await app.evaluate('mergeAssetReads');
        assert.ok(reads.length > 0); assert.ok(reads.every(url => decodeURIComponent(url).endsWith(keys[17])), `${reads.length} reads for one selected preview: ${reads.slice(0, 3).join(', ')}`);
        assert.equal(await app.evaluate("document.querySelector('#durable-merge-merge-preview .image-save-preview-counter').textContent"), '18/64');
        assert.equal(await app.evaluate("fetch('/api/workflows/Merge%20Budget').then(response=>response.text())"), before);
    });
});
