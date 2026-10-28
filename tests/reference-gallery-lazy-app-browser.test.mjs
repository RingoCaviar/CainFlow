import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = { autoCheckUpdatesOnLoad: false, models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }], nodes: [], connections: [] };

test('gallery public component defers hidden and offscreen thumbnail work and stops observers on teardown', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        // Exercise the exported gallery component in a real browser document.
        // Its supplied callbacks are the public boundary for thumbnail work;
        // no application state or media cache internals are inspected.
        await app.evaluate(`(async()=>{const {createImageReferenceOverview}=await import('/js/nodes/image-reference-overview.js');
            const {cleanupElementResources}=await import('/js/core/common-utils.js');
            const host=document.createElement('section');host.id='gallery-contract';host.hidden=true;host.style.cssText='position:fixed;left:20px;top:80px;width:480px;z-index:9999;background:var(--panel-bg)';
            const target={id:'lazy-gallery-target',type:'ImageGenerate',el:document.createElement('div')};target.el.innerHTML='<div id="lazy-gallery-target-reference-sources" class="image-reference-sources"></div>';host.append(target.el);document.body.append(host);
            const sources=Array.from({length:64},(_,index)=>({id:'lazy-source-'+index,type:'ImageImport',enabled:true,data:{image:${JSON.stringify(png)}},el:document.createElement('div')}));
            const state={nodes:new Map([[target.id,target],...sources.map(source=>[source.id,source])]),connections:sources.map((source,order)=>({id:'lazy-edge-'+order,from:{nodeId:source.id,port:'image'},to:{nodeId:target.id,port:'referenceImages'},type:'image',order})),runningNodeIds:new Set()};
            window.galleryThumbnailCalls=[];
            const gallery=createImageReferenceOverview({state,documentRef:document,getCachedOutputValue:source=>source.data.image,
                createThumbnail:async source=>{window.galleryThumbnailCalls.push(source);return source}});
            gallery.render(target.id);
            window.galleryContract={host,target,sources,gallery,cleanup:()=>cleanupElementResources(target.el)};
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        assert.equal(await app.evaluate('window.galleryThumbnailCalls.length'), 0, 'a hidden editor does not start decoding its reference batch');
        assert.equal(await app.evaluate("document.querySelectorAll('#gallery-contract [data-source-image-index]').length"), 64);
        await app.evaluate('window.galleryContract.host.hidden=false');
        await app.waitFor('window.galleryThumbnailCalls.length>0');
        const visibleCalls = await app.evaluate('window.galleryThumbnailCalls.length');
        assert.ok(visibleCalls < 64, `only visible references and a small margin are prepared, got ${visibleCalls}`);
        await app.evaluate("document.querySelector('#gallery-contract .image-reference-grid').scrollTo({top:100000})");
        await app.waitFor("!!document.querySelector('#gallery-contract [data-reference-number=\"64\"] img')?.getAttribute('src')");
        assert.equal(await app.evaluate("document.querySelector('#gallery-contract [data-reference-number=\"64\"] img').src"), png);

        await app.evaluate(`(()=>{const contract=window.galleryContract;contract.host.hidden=true;contract.sources[0].customTitle='updated source';contract.gallery.render(contract.target.id);contract.cleanup();window.galleryCallsAtCleanup=window.galleryThumbnailCalls.length;contract.host.hidden=false;})()`);
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate('window.galleryThumbnailCalls.length'), await app.evaluate('window.galleryCallsAtCleanup'), 'removing the component disconnects its replacement observer');
    });
});
