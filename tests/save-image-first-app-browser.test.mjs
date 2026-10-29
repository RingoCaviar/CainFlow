import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';

const originals = await Promise.all(['red', 'blue', 'orange'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] },
        { id: 'video', modelId: 'veo-3', name: '受控视频', protocol: 'veo-unified', taskType: 'video', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodeDefaults: { VideoGenerate: { apiConfigId: 'video', providerId: 'p' } }
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const edge = (id, source, target, type) => ({ id, from: { nodeId: source, port: type }, to: { nodeId: target, port: type }, type });

async function openSettings(app, id = 'save') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}

async function closeSettings(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
}

async function changeFilename(app, value, id = 'save') {
    await app.evaluate(`(()=>{const input=document.getElementById('${id}-filename');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='${id}')?.filename===${JSON.stringify(value)})`);
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect(),direction=element.closest('.node-port')?.dataset.direction;return {x:rect.x+rect.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:rect.y+rect.height/2}})()`);
}

async function drag(app, selector, destination) {
    await closeSettings(app);
    const from = await point(app, selector);
    assert.ok(await app.evaluate(`Boolean(document.elementFromPoint(${from.x},${from.y})?.closest('.node-port'))`), 'the dragged media port is reachable');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 30, y: from.y + 15, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destination, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 });
}

async function connect(app, source, type) {
    await drag(app, `#${source} .node-port[data-direction=output][data-port=${type}] .port-dot`, await point(app, '#save .universal-input .port-dot'));
}

async function history(app, key, feedback) {
    await app.evaluate(`(()=>{window.saveHistorySeen=false;const observer=new MutationObserver(records=>{const added=records.flatMap(record=>Array.from(record.addedNodes));if(added.some(node=>node.textContent?.includes(${JSON.stringify(feedback)}))){window.saveHistorySeen=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('saveHistorySeen===true');
}

async function expectGraph(app, nodes, connections) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===${nodes}&&document.value.connections.length===${connections.length}&&${JSON.stringify(connections)}.every((edge,index)=>document.value.connections[index]?.from.nodeId===edge.from.nodeId&&document.value.connections[index]?.from.port===edge.from.port&&document.value.connections[index]?.to.nodeId===edge.to.nodeId&&document.value.connections[index]?.to.port===edge.to.port))`);
    assert.deepEqual((await saved(app)).connections, connections);
}

async function countRequests(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.saveRequests=[];const nativeFetch=window.fetch;window.fetch=(url,options={})=>{if(String(url)==='/proxy')saveRequests.push({method:options.method||'GET'});return nativeFetch(url,options)};" });
    await reloadAppBrowser(app);
}

async function createVideoAsset(app) {
    // Produce actual VP8 frames through the browser's native encoder. The
    // resulting EBML file is persisted by the real isolated storage backend.
    return app.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const context=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:250000}),stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};recorder.start(80);for(let frame=0;frame<16;frame++){const pixels=context.createImageData(96,64);for(let index=0;index<pixels.data.length;index+=4){pixels.data[index]=(index*7+frame*23)%256;pixels.data[index+1]=(index*13+frame*37)%256;pixels.data[index+2]=(index*19+frame*41)%256;pixels.data[index+3]=255;}context.putImageData(pixels,0,0);context.fillStyle='#fff';context.fillRect(frame*5,20,12,20);await new Promise(resolve=>setTimeout(resolve,80));}recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());const blob=new Blob(chunks,{type:'video/webm'}),bytes=new Uint8Array(await blob.arrayBuffer());if(blob.size<1024)throw new Error('Recorded fixture video is unexpectedly small');const response=await fetch('/api/storage/media-assets',{method:'PUT',headers:{'Content-Type':'video/webm','X-CainFlow-Media-Owner-Type':'test-fixture','X-CainFlow-Media-Owner-Id':'save-recorded-video'},body:blob});if(!response.ok)throw new Error(await response.text());const result=await response.json(),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');return {key:result.asset.asset_key,size:blob.size,head:Array.from(bytes.slice(0,4)),digest};})()");
}

async function controlled(app, { held = false } = {}) {
    const video = await createVideoAsset(app), directory = join(app.server.dataDir, 'save-exports');
    assert.deepEqual(video.head, [0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(await app.evaluate(`fetch('/api/storage/export-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory:${JSON.stringify(directory)}})}).then(response=>response.ok)`), true);
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.saveRequests=[];window.savePending=false;window.saveHoldVideo=${held};const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'){if(!options.body){saveRequests.push({kind:'poll'});return new Response(JSON.stringify({status:'completed',video_url:location.origin+'/api/storage/assets/'+encodeURIComponent(${JSON.stringify(video.key)})}),{headers:{'Content-Type':'application/json'}});}const body=JSON.parse(options.body);if(typeof body.prompt==='string'){const isVideo=body.model==='veo-3';saveRequests.push({kind:isVideo?'video':'image',body});if(isVideo){if(saveHoldVideo){savePending=true;await new Promise(resolve=>window.releaseSaveVideo=resolve);}return new Response(JSON.stringify({id:'save-video-'+saveRequests.length,task_id:'save-video-'+saveRequests.length,status:'submitted'}),{headers:{'Content-Type':'application/json'}});}const images=${JSON.stringify(originals)},index=saveRequests.filter(request=>request.kind==='image').length-1;return new Response(JSON.stringify({data:[{b64_json:images[index%images.length].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options);};` });
    await reloadAppBrowser(app);
    return { video, directory };
}

async function exportedFiles(directory, count) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const files = await readdir(directory).catch(() => []);
        if (files.length === count) return files.sort();
        await delay(50);
    }
    throw new Error(`Expected ${count} exported files, received ${JSON.stringify(await readdir(directory).catch(() => []))}`);
}

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor("Boolean(document.getElementById('save'))");
}

test('one save input routes image and video separately, rejects each occupied role, and reverse-creates a video source atomically', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'image-a', type: 'ImageImport', x: 20, y: 130 },
        { id: 'image-b', type: 'ImageImport', x: 20, y: 390 },
        ...['video-a', 'video-b'].map((id, index) => ({ id, type: 'VideoGenerate', x: 320, y: 130 + index * 400, apiConfigId: 'video', providerId: 'p', prompt: 'must not run' })),
        { id: 'save', type: 'ImageSave', x: 800, y: 220, width: 250, height: 360, userResized: true }
    ], connections: [] }, async app => {
        await countRequests(app);
        await app.waitFor("Boolean(document.querySelector('#save .universal-input'))");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#save .node-port[data-direction=output]')].map(port=>({port:port.dataset.port,type:port.dataset.type}))"), [{ port: 'image', type: 'image' }, { port: 'video', type: 'video' }]);
        await connect(app, 'image-a', 'image');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===1)");
        const image = (await saved(app)).connections[0];
        assert.deepEqual([image.from, image.to, image.type], [{ nodeId: 'image-a', port: 'image' }, { nodeId: 'save', port: 'image' }, 'image']);
        await connect(app, 'video-a', 'video');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===2)");
        const full = (await saved(app)).connections;
        assert.deepEqual([full[1].from, full[1].to, full[1].type], [{ nodeId: 'video-a', port: 'video' }, { nodeId: 'save', port: 'video' }, 'video']);
        for (const [source, type] of [['image-b', 'image'], ['video-b', 'video']]) {
            await connect(app, source, type);
            await app.waitFor("document.getElementById('toast-container').innerText.includes('已占用')");
            await expectGraph(app, 5, full);
        }
        await history(app, 'z', '已撤回'); await expectGraph(app, 5, [image]);
        await history(app, 'y', '已重做'); await expectGraph(app, 5, full);
        await history(app, 'z', '已撤回'); await expectGraph(app, 5, [image]);
        assert.equal(await app.evaluate("Boolean(document.elementFromPoint(300,740)?.closest('#canvas-container'))&&!document.elementFromPoint(300,740)?.closest('.node')"), true, await app.evaluate("document.elementFromPoint(300,740)?.outerHTML.slice(0,300)"));
        await drag(app, '#save .universal-input .port-dot', { x: 300, y: 740 });
        await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
        await app.evaluate("document.querySelector('#connection-create-popup [data-popup-node-type=ImageSave]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===6&&document.value.connections.length===2)");
        const created = await saved(app), source = created.nodes.find(node => !['image-a', 'image-b', 'video-a', 'video-b', 'save'].includes(node.id));
        const link = created.connections.find(connection => connection.id !== image.id);
        assert.equal(source.type, 'ImageSave');
        assert.deepEqual([link.from, link.to, link.type], [{ nodeId: source.id, port: 'video' }, { nodeId: 'save', port: 'video' }, 'video'], 'reverse creation considers the multi-output source video port when the image role is full');
        await history(app, 'z', '已撤回'); await expectGraph(app, 5, [image]);
        await history(app, 'y', '已重做'); await expectGraph(app, 6, created.connections);
        assert.equal(await app.evaluate('saveRequests.length'), 0, 'connection edits, undo and redo never start provider requests');
    });
});

test('a video output creates a save node using its real video role and cancelling the picker leaves the graph intact', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'video', type: 'VideoGenerate', x: 30, y: 180, apiConfigId: 'video', providerId: 'p', prompt: 'do not generate' }], connections: [] }, async app => {
        await countRequests(app);
        await drag(app, '#video .node-port[data-direction=output][data-port=video] .port-dot', { x: 750, y: 260 });
        await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.getElementById('connection-create-popup').classList.contains('hidden')");
        await expectGraph(app, 1, []);
        await drag(app, '#video .node-port[data-direction=output][data-port=video] .port-dot', { x: 750, y: 260 });
        await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
        await app.evaluate("document.querySelector('#connection-create-popup [data-popup-node-type=ImageSave]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===2&&document.value.connections.length===1)");
        const graph = await saved(app), target = graph.nodes.find(node => node.type === 'ImageSave');
        assert.deepEqual([graph.connections[0].from, graph.connections[0].to, graph.connections[0].type], [{ nodeId: 'video', port: 'video' }, { nodeId: target.id, port: 'video' }, 'video']);
        await history(app, 'z', '已撤回'); await expectGraph(app, 1, []);
        await history(app, 'y', '已重做'); await expectGraph(app, 2, graph.connections);
        assert.equal(await app.evaluate('saveRequests.length'), 0);
    });
});

test('a save retains playable video and the whole image batch, writes real files and keeps native media stable across filename edits', { timeout: 90000 }, async () => {
    const connections = [edge('images-save', 'images', 'save', 'image'), edge('videos-save', 'videos', 'save', 'video'), edge('images-forward', 'save', 'image-output', 'image'), edge('videos-forward', 'save', 'video-output', 'video')];
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'images', type: 'ImageGenerate', x: 20, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'save original images', generationCount: 3 },
        { id: 'videos', type: 'VideoGenerate', x: 20, y: 600, apiConfigId: 'video', providerId: 'p', prompt: 'save playable clips', generationCount: 2 },
        { id: 'save', type: 'ImageSave', x: 550, y: 160, width: 350, height: 410, userResized: true, customTitle: '保存完整媒体', filename: 'initial-bundle' },
        { id: 'image-output', type: 'ImagePreview', x: 1000, y: 160 },
        { id: 'video-output', type: 'ImageSave', x: 1400, y: 160, filename: 'forwarded-clips' },
        { id: 'note', type: 'Text', x: 950, y: 650, text: 'another selected node' }
    ], connections }, async app => {
        const { video, directory } = await controlled(app);
        await openSettings(app); await changeFilename(app, 'retained-bundle'); await closeSettings(app);
        await app.evaluate("document.getElementById('note').click();document.getElementById('btn-run').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='save');return node?.mediaAssetKeys?.length===3&&node?.videos?.length===2})");
        await app.waitFor("document.getElementById('btn-stop').disabled");
        const files = await exportedFiles(directory, 7), mainFiles = files.filter(name => name.startsWith('retained-bundle'));
        assert.equal(mainFiles.length, 5, 'automatic saving includes three images and both videos using the closed panel filename');
        assert.equal(files.filter(name => name.startsWith('forwarded-clips')).length, 2, 'the separate video output forwards the complete clip list');
        const pngFiles = mainFiles.filter(name => name.endsWith('.png')), videoFiles = mainFiles.filter(name => name.endsWith('.webm'));
        assert.equal(pngFiles.length, 3); assert.equal(videoFiles.length, 2);
        const pngHashes = await Promise.all(pngFiles.map(async name => createHash('sha256').update(await readFile(join(directory, name))).digest('hex')));
        assert.deepEqual(pngHashes.sort(), originals.map(value => createHash('sha256').update(Buffer.from(value.split(',')[1], 'base64')).digest('hex')).sort());
        for (const name of videoFiles) assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), video.digest, 'the saved video contains the actual recorded frames');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='image-output')?.mediaAssetKeys?.length===3&&document.value.nodes.find(node=>node.id==='video-output')?.videos?.length===2)");
        const graph = await saved(app), result = graph.nodes.find(node => node.id === 'save'), source = graph.nodes.find(node => node.id === 'videos');
        assert.ok(result.videos.every(item => item.assetKey?.startsWith('media:')), 'each clip has its own durable Media asset reference');
        assert.deepEqual(result.mediaAssetKeys, graph.nodes.find(node => node.id === 'images').mediaAssetKeys);
        assert.deepEqual(graph.nodes.find(node => node.id === 'image-output').mediaAssetKeys, result.mediaAssetKeys);
        assert.equal(source.videos?.length, 2, 'the generated source retains both durable clips');
        assert.deepEqual(result.videos.map(item => item.assetKey), source.videos.map(item => item.assetKey));
        assert.deepEqual(graph.nodes.find(node => node.id === 'video-output').videos.map(item => item.assetKey), result.videos.map(item => item.assetKey));
        assert.deepEqual(graph.connections, connections);
        await app.waitFor("document.querySelector('#save-save-preview .image-save-video-pane video')?.videoWidth===96");
        await app.evaluate("(async()=>{const video=document.querySelector('#save-save-preview .image-save-video-pane video');video.muted=true;await video.play()})()");
        await app.waitFor("document.querySelector('#save-save-preview .image-save-video-pane video').currentTime>0.05");
        await closeSettings(app);
        const controlPoint = await app.evaluate("(()=>{const rect=document.querySelector('#save-save-preview .image-save-video-pane video').getBoundingClientRect();return {x:rect.left+20,y:rect.bottom-20}})()");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...controlPoint, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...controlPoint, button: 'left', clickCount: 1 });
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true, 'native video controls take priority over opening node parameters');
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
        const currentTime = await app.evaluate("(()=>{window.savedNativeVideo=document.querySelector('#save-save-preview .image-save-video-pane video');savedNativeVideo.pause();return savedNativeVideo.currentTime})()");
        const geometry = await app.evaluate("(()=>{const node=document.getElementById('save');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
        await openSettings(app); await changeFilename(app, 'edited-bundle'); await closeSettings(app);
        await app.evaluate("document.getElementById('note').click()");
        await openSettings(app); await closeSettings(app);
        assert.equal(await app.evaluate("savedNativeVideo===document.querySelector('#save-save-preview .image-save-video-pane video') && savedNativeVideo.controls"), true);
        assert.ok(Math.abs(await app.evaluate('savedNativeVideo.currentTime') - currentTime) < 0.1, 'unrelated settings and selection preserve playback position');
        await app.evaluate("document.querySelector('#save-save-preview [data-save-preview-mode=image]').click()");
        await app.waitFor("document.querySelector('#save-save-preview .image-save-image-pane .image-save-preview-counter')?.textContent.endsWith('/3')");
        await app.evaluate("document.querySelector('#save-save-preview [data-save-preview-mode=video]').click();const select=document.querySelector('#save-save-preview [data-save-video-index]');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='save');return node?.videoPreviewIndex===0&&node?.savePreviewMode==='video'})");
        assert.equal(await app.evaluate("savedNativeVideo===document.querySelector('#save-save-preview .image-save-video-pane video')"), true);
        assert.ok(Math.abs(await app.evaluate('savedNativeVideo.currentTime') - currentTime) < 0.1);
        await openSettings(app);
        await app.evaluate("window.manualSaveCalls=[];window.manualSaveMode='save';window.__cainflowDesktop={saveFile:async(filename,mime,source)=>{if(manualSaveMode==='cancel'){manualSaveCalls.push({filename,status:'cancelled'});return null}if(manualSaveMode==='fail'){manualSaveCalls.push({filename,status:'failed'});throw new Error('controlled save failure')}const blob=source instanceof Blob?source:await(await fetch(source)).blob(),bytes=new Uint8Array(await blob.arrayBuffer());manualSaveCalls.push({filename,mime:blob.type,requestedMime:mime,size:blob.size,head:Array.from(bytes.slice(0,4)),status:'saved'});return 'controlled-output/'+filename}};document.getElementById('save-manual-save').click()");
        await app.waitFor("manualSaveCalls.length===5 && manualSaveCalls.every(call=>call.status==='saved')");
        const downloads = await app.evaluate('manualSaveCalls');
        assert.ok(downloads.every(item => item.filename.startsWith('edited-bundle')));
        assert.equal(downloads.filter(item => item.mime === 'image/png').length, 3);
        assert.equal(downloads.filter(item => item.mime === 'video/webm' && item.head.join(',') === '26,69,223,163' && item.size === video.size).length, 2, 'manual saving passes real playable video blobs through the platform boundary');
        assert.ok(downloads.filter(item => item.mime === 'video/webm').every(item => item.filename.endsWith('.webm') && item.requestedMime === 'video/webm'), 'manual filenames and MIME match the actual local video encoding');
        await app.evaluate("manualSaveCalls=[];manualSaveMode='cancel';document.getElementById('save-manual-save').click()");
        await app.waitFor('manualSaveCalls.length===5');
        assert.ok((await app.evaluate('manualSaveCalls')).every(item => item.status === 'cancelled'));
        await app.evaluate("manualSaveCalls=[];manualSaveMode='fail';document.getElementById('save-manual-save').click()");
        await app.waitFor("document.getElementById('toast-container').innerText.includes('controlled save failure')");
        assert.deepEqual((await readdir(directory)).sort(), files, 'cancelled or failed manual saves do not change the configured directory contents');
        assert.equal(await app.evaluate("fetch('/api/storage/export-directory').then(response=>response.json()).then(result=>result.directory)"), directory);
        assert.deepEqual((await saved(app)).connections, connections);
        await app.evaluate("document.getElementById('btn-save-workflow').click()");
        await app.waitFor("document.getElementById('toolbar-workflow-status').dataset.state==='saved'");
        const owner = await app.evaluate("(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value;return (await fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(graph.activeWorkflowId)).then(response=>response.json())).owners.find(owner=>owner.ownerType==='workflow-node'&&owner.ownerId==='save')})()");
        for (const key of [...result.mediaAssetKeys, ...result.videos.map(item => item.assetKey)]) assert.ok(owner.assetKeys.includes(key), 'the save node independently protects each retained image and clip');
        await reloadAppBrowser(app); await openSettings(app);
        assert.equal(await app.evaluate("document.getElementById('save-filename').value"), 'edited-bundle');
        const restored = (await saved(app)).nodes.find(node => node.id === 'save');
        assert.deepEqual(restored.mediaAssetKeys, result.mediaAssetKeys);
        assert.deepEqual(restored.videos.map(item => item.assetKey), result.videos.map(item => item.assetKey));
        assert.equal(restored.videoPreviewIndex, 0); assert.equal(restored.savePreviewMode, 'video');
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('save');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()"), geometry);
        assert.equal(restored.customTitle, '保存完整媒体');
        assert.equal(source.videos?.length, 2, 'the generated source retains its complete video list');
        assert.deepEqual(source.videos.map(item => item.assetKey), result.videos.map(item => item.assetKey));
        assert.deepEqual(source.videos.map(item => item.id), result.videos.map(item => item.id));
        assert.deepEqual(graph.nodes.find(node => node.id === 'video-output').videos.map(item => item.id), result.videos.map(item => item.id), 'video task identities and their order survive the separate output');
        assert.equal(await app.evaluate('saveRequests.length'), 0, 'reopening uses retained media without another provider request');
    });
});

test('background saving uses A filename and media while a same-ID save node in B remains unchanged', { timeout: 90000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        const { directory, video } = await controlled(app, { held: true });
        const graphs = [
            { name: 'Save A', workflowId: 'save-background-a', nodes: [
                { id: 'images', type: 'ImageGenerate', x: 20, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'background images', generationCount: 3 },
                { id: 'videos', type: 'VideoGenerate', x: 20, y: 600, apiConfigId: 'video', providerId: 'p', prompt: 'background playable video' },
                { id: 'save', type: 'ImageSave', x: 550, y: 160, width: 350, height: 410, userResized: true, filename: 'initial-A' }
            ], connections: [edge('images-save', 'images', 'save', 'image'), edge('videos-save', 'videos', 'save', 'video')] },
            { name: 'Save B', workflowId: 'save-background-b', nodes: [
                { id: 'save', type: 'ImageSave', x: 550, y: 160, width: 350, height: 410, userResized: true, filename: 'B-output' }
            ], connections: [] }
        ];
        for (const { name, ...graph } of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Save A'); await openSettings(app); await changeFilename(app, 'chosen-A'); await closeSettings(app);
        const directoryReadiness = await app.evaluate("(()=>{const warning=document.getElementById('save-path-warning');return {warningHidden:warning?.classList.contains('hidden'),warning:warning?.textContent}})()");
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor('savePending===true');
        await activate(app, 'Save B'); await openSettings(app);
        assert.equal(await app.evaluate("document.getElementById('save-filename').value"), 'B-output');
        assert.equal(await app.evaluate("document.querySelector('.workflow-item[data-name=\"Save A\"]').classList.contains('is-running')"), true, 'A is still running while the controlled video response is held');
        await app.evaluate('releaseSaveVideo()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Save A\"]').classList.contains('is-running')");
        const files = await exportedFiles(directory, 4).catch(async error => {
            await activate(app, 'Save A');
            const state = (await saved(app)).nodes.map(({ id, type, filename, mediaAssetKeys, videos, lastDuration }) => ({ id, type, filename, keyCount: mediaAssetKeys?.length, videos: videos?.length, lastDuration }));
            throw new Error(`${error.message}\nDirectory before run: ${JSON.stringify(directoryReadiness)}\nA results: ${JSON.stringify(state)}\n${await app.evaluate("document.body.innerText.slice(-9000)")}`, { cause: error });
        });
        assert.ok(files.every(name => name.startsWith('chosen-A')), 'detached execution uses A filename instead of the visible B field');
        const webm = files.find(name => name.endsWith('.webm'));
        assert.ok(webm); assert.equal(createHash('sha256').update(await readFile(join(directory, webm))).digest('hex'), video.digest);
        const other = await saved(app), untouched = other.nodes.find(node => node.id === 'save');
        assert.equal(other.activeWorkflowId, 'save-background-b');
        assert.equal(untouched.filename, 'B-output');
        assert.ok(!untouched.mediaAssetKeys?.length && !untouched.videos?.length);
        assert.deepEqual(other.connections, []);
        await activate(app, 'Save A'); await openSettings(app);
        assert.equal(await app.evaluate("document.getElementById('save-filename').value"), 'chosen-A');
        const completed = await saved(app), result = completed.nodes.find(node => node.id === 'save');
        assert.deepEqual(result.mediaAssetKeys, completed.nodes.find(node => node.id === 'images').mediaAssetKeys);
        assert.equal(result.mediaAssetKeys.length, 3); assert.equal(result.videos.length, 1);
        assert.equal(result.videos[0].assetKey, completed.nodes.find(node => node.id === 'videos').videos[0].assetKey);
        assert.deepEqual(completed.connections, graphs[0].connections);
        await app.evaluate("document.getElementById('btn-save-workflow').click()");
        await app.waitFor("document.getElementById('toolbar-workflow-status').dataset.state==='saved'");
        const owners = await app.evaluate("Promise.all(['save-background-a','save-background-b'].map(id=>fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(id)).then(response=>response.json()).then(result=>result.owners.filter(owner=>owner.ownerType==='workflow-node'&&owner.ownerId==='save'))))");
        for (const key of [...result.mediaAssetKeys, result.videos[0].assetKey]) assert.ok(owners[0][0]?.assetKeys.includes(key));
        assert.ok(owners[1].every(owner => !owner.assetKeys.length));
        await reloadAppBrowser(app); await openSettings(app);
        const restored = (await saved(app)).nodes.find(node => node.id === 'save');
        assert.equal(restored.filename, 'chosen-A');
        assert.deepEqual(restored.mediaAssetKeys, result.mediaAssetKeys);
        assert.equal(restored.videos[0].assetKey, result.videos[0].assetKey);
        assert.equal(await app.evaluate("fetch('/api/storage/export-directory').then(response=>response.json()).then(result=>result.directory)"), directory);
        await activate(app, 'Save B');
        assert.equal((await saved(app)).nodes.find(node => node.id === 'save').filename, 'B-output');
        assert.ok(!(await saved(app)).nodes.find(node => node.id === 'save').mediaAssetKeys?.length);
    });
});
