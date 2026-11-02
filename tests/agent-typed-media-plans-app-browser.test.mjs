import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';

const blueFile = fileURLToPath(new URL('./fixtures/reference-blue.png', import.meta.url));
const blueHash = createHash('sha256').update(await readFile(blueFile)).digest('hex');
const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'video', modelId: 'veo-3', name: '受控视频', protocol: 'veo-unified', taskType: 'video', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value)");
const graph = async app => { const { nodes, connections } = await saved(app); return { nodes, connections }; };
const lastPlan = "[...document.querySelectorAll('.prompt-agent-canvas-plan')].at(-1)";
const status = `${lastPlan}?.querySelector('[role=status]')?.textContent`;

async function controlled(app, video = null) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.typedMediaRequests=[];window.typedMediaReply={intent:'chat',message:'等待明确方案'};const typedMediaFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'){if(!options.body){typedMediaRequests.push({kind:'poll'});return new Response(JSON.stringify({status:'completed',video_url:location.origin+'/api/storage/assets/'+encodeURIComponent(${JSON.stringify(video?.key || '')})}),{headers:{'Content-Type':'application/json'}});}const body=JSON.parse(options.body);if(body.messages){typedMediaRequests.push({kind:'chat',body});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(typedMediaReply)}}]}),{headers:{'Content-Type':'application/json'}});}if(typeof body.prompt==='string'){typedMediaRequests.push({kind:'video',body});if(body.model!=='veo-3')throw new Error('Unexpected provider request');return new Response(JSON.stringify({id:'typed-video-task',task_id:'typed-video-task',status:'submitted'}),{headers:{'Content-Type':'application/json'}});}}return typedMediaFetch(url,options)};` });
    await reloadAppBrowser(app);
}

async function nativeClick(app, expression) {
    await app.evaluate(`(${expression}).scrollIntoView({block:'nearest'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const point = await app.evaluate(`(()=>{const rect=(${expression}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    assert.equal(await app.evaluate(`(${expression}).contains(document.elementFromPoint(${point.x},${point.y}))`), true, 'the requested Agent control is reachable');
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function propose(app, plan, request, mentions = []) {
    const count = await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length");
    await app.evaluate(`typedMediaReply=${JSON.stringify({ intent: 'generate', message: '请检查媒体用途与原输入', canvasPlan: plan })};document.querySelector('[data-parameter-action=front-agent]').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.getElementById('prompt-agent-input').value='';`);
    for (const [id, name] of mentions) {
        await app.evaluate(`(()=>{const input=document.getElementById('prompt-agent-input');input.value+=${JSON.stringify('@' + name)};input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        await app.waitFor(`Boolean([...document.querySelectorAll('.prompt-agent-node-mentions [role=option]')].find(option=>option.textContent.endsWith(${JSON.stringify(' · ' + id)})))`);
        await app.evaluate(`[...document.querySelectorAll('.prompt-agent-node-mentions [role=option]')].find(option=>option.textContent.endsWith(${JSON.stringify(' · ' + id)})).click()`);
    }
    await app.evaluate(`(()=>{const input=document.getElementById('prompt-agent-input');input.value+=${JSON.stringify(request)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await nativeClick(app, "document.getElementById('prompt-agent-send')");
    await app.waitFor(`document.querySelectorAll('.prompt-agent-canvas-plan').length===${count + 1}&&document.getElementById('prompt-agent-cancel').hidden`);
    assert.equal(await app.evaluate("document.getElementById('prompt-agent-image-model').value"), '', 'processing-only plans do not select an image generation model');
}

async function action(app, label) {
    const expression = `[...(${lastPlan}).querySelectorAll('.prompt-agent-canvas-actions button')].find(button=>button.textContent===${JSON.stringify(label)})`;
    assert.equal(await app.evaluate(`(${expression}).disabled`), false, `${label} is available without a generation step or image model`);
    await nativeClick(app, expression);
}

async function uploadBlue(app) {
    const document = await app.send('DOM.getDocument');
    const input = await app.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#source-file' });
    await app.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [blueFile] });
    await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='source')?.mediaAssetKeys?.length===1)");
}

async function assetHash(app, key) {
    return app.evaluate(`(async()=>{const bytes=await(await fetch('/api/storage/assets/'+encodeURIComponent(${JSON.stringify(key)}))).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')})()`);
}

test('an explicit existing B-only Compare step applies and executes into a new Preview while missing B is rejected without graph changes', { timeout: 60000 }, async () => {
    const originalInput = { id: 'original-B-input', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'compare', port: 'imageB' }, type: 'image', order: 17 };
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'source', type: 'ImageImport', customTitle: '蓝色原图', x: 40, y: 100 },
        { id: 'compare', type: 'ImageCompare', customTitle: '现有单B对比', x: 460, y: 100, width: 350, height: 300, userResized: true }
    ], connections: [originalInput] }, async app => {
        await controlled(app); await uploadBlue(app);
        const original = await saved(app), sourceKey = original.nodes.find(node => node.id === 'source').mediaAssetKeys[0];
        assert.equal(await assetHash(app, sourceKey), blueHash);
        await propose(app, { version: 1, steps: [
            { id: 'compare-step', type: 'ImageCompare', nodeId: 'compare', parameters: {}, execute: true },
            { id: 'preview-step', type: 'ImagePreview', title: '单B对比输出', parameters: {} }
        ], connections: [{ from: { ref: 'compare-step', port: 'image' }, to: { ref: 'preview-step', port: 'image' }, type: 'image' }] }, '保留原B输入，A保持空，应用并更新对比输出。', [['compare', '现有单B对比']]);
        await action(app, '仅应用');
        await app.waitFor(`${status}?.includes('已应用并保存')`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.length===3)");
        const applied = await saved(app), preview = applied.nodes.find(node => node.type === 'ImagePreview');
        assert.equal(applied.nodes.length, 3);
        assert.deepEqual(applied.connections.find(edge => edge.id === originalInput.id), originalInput);
        assert.equal(applied.connections.some(edge => edge.to.nodeId === 'compare' && edge.to.port === 'imageA'), false);
        const outgoing = applied.connections.find(edge => edge.to.nodeId === preview.id);
        assert.deepEqual([outgoing.from, outgoing.to, outgoing.type], [{ nodeId: 'compare', port: 'image' }, { nodeId: preview.id, port: 'image' }, 'image']);
        await action(app, '应用并执行');
        await app.waitFor(`${status}?.includes('执行结束')`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id===${JSON.stringify(preview.id)})?.mediaAssetKeys?.[0]===${JSON.stringify(sourceKey)})`);
        const executed = await saved(app);
        assert.deepEqual(executed.connections, applied.connections, 'execution preserves the original B role and every applied connection ID');
        assert.deepEqual(executed.nodes.find(node => node.id === 'compare').mediaAssetKeys, [sourceKey]);
        assert.equal(await assetHash(app, executed.nodes.find(node => node.id === preview.id).mediaAssetKeys[0]), blueHash);
        assert.equal(await app.evaluate("typedMediaRequests.filter(request=>request.kind!=='chat').length"), 0);
        const beforeRejected = await graph(app);
        await propose(app, { version: 1, steps: [{ id: 'missing-b', type: 'ImageCompare', title: '缺少B的对比', parameters: {} }],
            connections: [{ from: { ref: 'source', port: 'image' }, to: { ref: 'missing-b', port: 'imageA' }, type: 'image' }] }, '仅连接A，检查缺少必需B时拒绝应用。', [['source', '蓝色原图']]);
        await action(app, '仅应用');
        await app.waitFor(`${status}?.includes('缺少必要图片输入')`);
        assert.deepEqual(await graph(app), beforeRejected);
        assert.equal(await assetHash(app, sourceKey), blueHash);
    });
});

async function createVideoAsset(app) {
    return app.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const context=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:250000}),stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};recorder.start(80);for(let frame=0;frame<16;frame++){const pixels=context.createImageData(96,64);for(let index=0;index<pixels.data.length;index+=4){pixels.data[index]=(index*7+frame*23)%256;pixels.data[index+1]=(index*13+frame*37)%256;pixels.data[index+2]=(index*19+frame*41)%256;pixels.data[index+3]=255}context.putImageData(pixels,0,0);context.fillStyle='#fff';context.fillRect(frame*5,20,12,20);await new Promise(resolve=>setTimeout(resolve,80))}recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());const blob=new Blob(chunks,{type:'video/webm'}),bytes=new Uint8Array(await blob.arrayBuffer());if(blob.size<1024)throw new Error('The native recording is unexpectedly small');const response=await fetch('/api/storage/media-assets',{method:'PUT',headers:{'Content-Type':'video/webm','X-CainFlow-Media-Owner-Type':'test-fixture','X-CainFlow-Media-Owner-Id':'agent-typed-media-video'},body:blob});if(!response.ok)throw new Error(await response.text());const result=await response.json(),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');return {key:result.asset.asset_key,size:blob.size,head:Array.from(bytes.slice(0,4)),digest}})()");
}

test('a new video-only Agent Save uses the real Veo output, local bytes, player and owner while an empty-media Save is rejected atomically', { timeout: 90000 }, async () => {
    const originalInput = { id: 'original-video-role', from: { nodeId: 'video', port: 'video' }, to: { nodeId: 'retained', port: 'video' }, type: 'video' };
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'video', type: 'VideoGenerate', customTitle: '原始视频来源', x: 40, y: 120, apiConfigId: 'video', providerId: 'p', prompt: 'controlled playable original' },
        { id: 'retained', type: 'ImageSave', x: 500, y: 120, filename: 'original-unused-save' }
    ], connections: [originalInput] }, async app => {
        const video = await createVideoAsset(app), directory = join(app.server.dataDir, 'typed-video-exports');
        assert.deepEqual(video.head, [0x1a, 0x45, 0xdf, 0xa3]);
        assert.equal(await app.evaluate(`fetch('/api/storage/export-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory:${JSON.stringify(directory)}})}).then(response=>response.ok)`), true);
        await controlled(app, video);
        await app.evaluate("document.getElementById('video').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='video')?.videos?.[0]?.assetKey?.startsWith('media:'))");
        await app.waitFor("document.getElementById('btn-stop').disabled");
        const source = (await saved(app)).nodes.find(node => node.id === 'video');
        assert.equal(await assetHash(app, source.videos[0].assetKey), video.digest);
        await propose(app, { version: 1, steps: [{ id: 'save-video', type: 'ImageSave', title: '仅保存视频', parameters: { filename: 'agent-video-only' } }],
            connections: [{ from: { ref: 'video', port: 'video' }, to: { ref: 'save-video', port: 'video' }, type: 'video' }] }, '把原始完整视频保存到新节点，不使用图片输入。', [['video', '原始视频来源']]);
        await action(app, '仅应用');
        await app.waitFor(`${status}?.includes('已应用并保存')`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.length===3)");
        const applied = await saved(app), target = applied.nodes.find(node => node.type === 'ImageSave' && node.id !== 'retained');
        assert.equal(applied.nodes.length, 3);
        assert.deepEqual(applied.connections.find(edge => edge.id === originalInput.id), originalInput);
        const input = applied.connections.find(edge => edge.to.nodeId === target.id);
        assert.deepEqual([input.from, input.to, input.type], [{ nodeId: 'video', port: 'video' }, { nodeId: target.id, port: 'video' }, 'video']);
        assert.equal(await app.evaluate("typedMediaRequests.filter(request=>request.kind==='video').length"), 1);
        await action(app, '应用并执行');
        await app.waitFor(`${status}?.includes('执行结束')`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id===${JSON.stringify(target.id)})?.videos?.length===1)`);
        const executed = await saved(app), result = executed.nodes.find(node => node.id === target.id);
        assert.deepEqual(executed.connections, applied.connections);
        assert.deepEqual(result.videos.map(item => [item.id, item.assetKey]), source.videos.map(item => [item.id, item.assetKey]));
        assert.ok(!result.mediaAssetKeys?.length, 'the Save really has only the video role');
        await waitForAutosave(app);
        const persisted = await app.evaluate("fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json())");
        assert.deepEqual(persisted.nodes.find(node => node.id === target.id).videos.map(item => [item.id, item.assetKey]), source.videos.map(item => [item.id, item.assetKey]), 'automatic saving persists the complete video identities');
        const ownerExpression = `fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(${JSON.stringify(executed.activeWorkflowId)})).then(response=>response.json()).then(record=>record.owners.find(owner=>owner.ownerType==='workflow-node'&&owner.ownerId===${JSON.stringify(target.id)}))`;
        try { await app.waitFor(`${ownerExpression}.then(owner=>owner?.assetKeys.includes(${JSON.stringify(source.videos[0].assetKey)}))`); }
        catch (error) { throw new Error('The new Save did not acquire ownership of its retained local clip: ' + JSON.stringify({ workflowId: executed.activeWorkflowId, target: target.id, owner: await app.evaluate(ownerExpression) }), { cause: error }); }
        const owner = await app.evaluate(ownerExpression);
        assert.ok(owner.assetKeys.includes(source.videos[0].assetKey), 'the new Save independently owns the retained local clip');
        const playerSelector = `#${target.id}-save-preview .image-save-video-pane video`;
        await app.waitFor(`document.querySelector(${JSON.stringify(playerSelector)})?.readyState>=2`);
        const player = await app.evaluate(`(async()=>{const video=document.querySelector(${JSON.stringify(playerSelector)});video.muted=true;await video.play();await new Promise(resolve=>setTimeout(resolve,250));video.pause();const bytes=await(await fetch(video.currentSrc)).arrayBuffer();return {controls:video.controls,width:video.videoWidth,height:video.videoHeight,time:video.currentTime,digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')}})()`);
        assert.deepEqual([player.controls, player.width, player.height], [true, 96, 64]);
        assert.ok(player.time > 0); assert.equal(player.digest, video.digest);
        let files = [];
        for (let attempt = 0; attempt < 100; attempt++) { files = await readdir(directory).catch(() => []); if (files.length) break; await delay(50); }
        assert.equal(files.length, 1); assert.match(files[0], /^agent-video-only.*\.webm$/);
        assert.equal(createHash('sha256').update(await readFile(join(directory, files[0]))).digest('hex'), video.digest);
        assert.deepEqual(await app.evaluate("typedMediaRequests.map(request=>request.kind)"), ['video', 'poll', 'chat'], 'executing the Save reuses its external source without billing or re-generating');
        const beforeRejected = await graph(app);
        await propose(app, { version: 1, steps: [{ id: 'missing-media', type: 'ImageSave', title: '没有媒体的保存', parameters: { filename: 'must-not-exist' } }], connections: [] }, '检查没有图片或视频输入的保存方案必须拒绝。');
        await action(app, '仅应用');
        await app.waitFor(`${status}?.includes('缺少必要媒体输入')`);
        assert.deepEqual(await graph(app), beforeRejected);
        assert.equal(await assetHash(app, source.videos[0].assetKey), video.digest);
    });
});
