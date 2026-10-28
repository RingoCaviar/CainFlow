import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const bytes = await readFile(new URL('./fixtures/reference-blue.png', import.meta.url));
const png = 'data:image/png;base64,' + bytes.toString('base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const taskId = 'native-image-task-019';
const configuration = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'async', name: '实际异步图片协议', modelId: 'image-async', protocol: 'newapi-image-async', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'async-image', type: 'ImageGenerate', x: 60, y: 140, width: 330, height: 260, userResized: true,
        apiConfigId: 'async', providerId: 'p', prompt: 'preserve this asynchronous image task', generationCount: 1,
        protocolParams: { size: '1024x1024', quality: 'hd', style: 'natural' } }], connections: [] };

async function nativeClick(app, selector) {
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    await app.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus({preventScroll:true})`);
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await app.waitFor(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)return false;element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
    const point = await app.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing native control: '+${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!element.contains(hit))throw new Error('Native control is covered: '+${JSON.stringify(selector)}+' '+JSON.stringify({rect:r.toJSON(),hit:hit?.className}));return{x,y}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
const session = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value)");
async function saveFile(app, condition) {
    await nativeClick(app, '#btn-save');
    await app.waitFor(`fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json()).then(graph=>{const node=graph.nodes?.find(node=>node.id==='async-image');return ${condition}})`);
    return app.evaluate("fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json())");
}

test('the original native async-image resume control restores the saved task, polls its exact identity and preserves the real original and index on reopen', { timeout: 60000 }, async () => {
    await withAppBrowser(configuration, async app => {
        const key = await app.evaluate(`(async()=>{const blob=await(await fetch(${JSON.stringify(png)})).blob();const response=await fetch('/api/storage/media-assets',{method:'PUT',headers:{'Content-Type':'image/png','X-CainFlow-Media-Owner-Type':'test-fixture','X-CainFlow-Media-Owner-Id':'async-original'},body:blob});if(!response.ok)throw new Error(await response.text());return(await response.json()).asset.asset_key})()`);
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.asyncImageRequests=[];window.asyncImageHeld=false;window.holdAsyncImage=true;const asyncImageFetch=window.fetch;window.fetch=async(url,options={})=>{
            const headers=new Headers(options.headers||{}),encoded=headers.get('x-target-url-b64')||'',target=encoded?atob(encoded.replace(/-/g,'+').replace(/_/g,'/')):'';
            if(String(url)==='/proxy'&&target.startsWith('https://controlled.test/')&&target.includes('/videos')){
                if(options.body){const body=JSON.parse(options.body);asyncImageRequests.push({kind:'create',target,body});return new Response(JSON.stringify({id:${JSON.stringify(taskId)},status:'submitted',progress:0}),{headers:{'Content-Type':'application/json'}})}
                asyncImageRequests.push({kind:'poll',target});if(holdAsyncImage){asyncImageHeld=true;await new Promise((resolve,reject)=>{const cancel=()=>{asyncImageHeld=false;reject(new DOMException('Stopped held async poll','AbortError'))};if(options.signal?.aborted)cancel();else options.signal?.addEventListener('abort',cancel,{once:true})})}
                return new Response(JSON.stringify({id:${JSON.stringify(taskId)},status:'completed',progress:100,image_url:location.origin+'/api/storage/assets/'+encodeURIComponent(${JSON.stringify(key)})}),{headers:{'Content-Type':'application/json'}});
            }return asyncImageFetch(url,options)};` });
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('async-image').click()");
        await app.waitFor("document.getElementById('image-parameter-panel').dataset.nodeId==='async-image'&&!document.getElementById('image-parameter-panel').hidden");
        await app.evaluate("document.getElementById('async-image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:230}))");
        await nativeClick(app, '#context-menu-run-to-here');
        await app.waitFor('asyncImageHeld===true');
        const created = await app.evaluate('asyncImageRequests');
        assert.equal(created.filter(request => request.kind === 'create').length, 1);
        assert.equal(created.find(request => request.kind === 'create').body.prompt, configuration.nodes[0].prompt);
        assert.ok(created.some(request => request.kind === 'poll' && request.target.endsWith('/' + taskId)));
        await nativeClick(app, '#btn-stop');
        await app.waitFor("!asyncImageHeld&&!document.getElementById('async-image').classList.contains('running')");
        const pending = await saveFile(app, `node?.imageTaskId===${JSON.stringify(taskId)}`);
        assert.equal(pending.nodes[0].imageTaskId, taskId); assert.equal(pending.nodes[0].apiConfigId, 'async');
        assert.ok(!pending.nodes[0].mediaAssetKeys?.length);
        await reloadAppBrowser(app);
        assert.deepEqual(await app.evaluate('asyncImageRequests'), [], 'loading the saved task never starts creation or polling');
        await app.evaluate("holdAsyncImage=false;document.getElementById('async-image').click()");
        await app.waitFor("document.getElementById('image-parameter-panel').dataset.nodeId==='async-image'&&!document.getElementById('image-parameter-panel').hidden");
        await nativeClick(app, '#image-parameter-panel [data-parameter-action=expand]');
        assert.equal(await app.evaluate("document.getElementById('async-image-resume-image-id').value"), taskId);
        await nativeClick(app, '#async-image-resume-image');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='async-image')?.mediaAssetKeys?.length===1)");
        await app.waitFor("!document.getElementById('async-image').classList.contains('running')&&document.getElementById('async-image-image-results').hidden===false");
        const requests = await app.evaluate('asyncImageRequests');
        assert.equal(requests.filter(request => request.kind === 'create').length, 0, 'resume never creates a replacement remote task');
        assert.ok(requests.length > 0 && requests.every(request => request.kind === 'poll' && request.target.endsWith('/' + taskId)));
        const completed = await saveFile(app, `node?.imageTaskId===${JSON.stringify(taskId)}&&node.imageTaskStatus==='completed'&&node.mediaAssetKeys?.length===1`);
        const result = completed.nodes.find(node => node.id === 'async-image');
        assert.deepEqual(result.mediaAssetKeys, [key]); assert.equal(result.imagePreviewIndex ?? 0, 0, 'a single-result task uses the existing implicit zero index');
        const actual = await app.evaluate(`fetch('/api/storage/assets/'+encodeURIComponent(${JSON.stringify(key)})).then(response=>response.arrayBuffer()).then(buffer=>Array.from(new Uint8Array(buffer)))`);
        assert.equal(hash(Buffer.from(actual)), hash(bytes));
        await reloadAppBrowser(app);
        assert.deepEqual(await app.evaluate('asyncImageRequests'), []);
        const reopened = (await session(app)).nodes.find(node => node.id === 'async-image');
        for (const field of ['imageTaskId', 'imageTaskStatus', 'imageTaskUrl', 'mediaAssetKeys', 'imagePreviewIndex', 'prompt', 'protocolParams']) assert.deepEqual(reopened[field], result[field], field);
        await app.waitFor("document.querySelector('#async-image-image-results img')?.naturalWidth>0");
        assert.equal(await app.evaluate("document.querySelector('#async-image-image-results img').alt"), '生成结果 1');
    });
});
