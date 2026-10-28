import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';

const originals = await Promise.all(['red', 'blue', 'orange'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const cameraValues = node => Object.fromEntries(['pitch', 'yaw', 'distance', 'fov', 'roll', 'cameraViewMode'].map(key => [key, node[key]]));

async function closeSettings(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect(),direction=element.closest('.node-port')?.dataset.direction;return {x:rect.x+rect.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:rect.y+rect.height/2}})()`);
}

async function drag(app, selector, destination) {
    await closeSettings(app);
    const from = await point(app, selector);
    assert.ok(await app.evaluate(`Boolean(document.elementFromPoint(${from.x},${from.y})?.closest('.node-port'))`), 'the dragged port is reachable');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 30, y: from.y + 15, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destination, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 });
}

async function connect(app, source, target = 'camera', port = 'image') {
    await drag(app, `#${source} .node-port[data-direction=output][data-port=${port}] .port-dot`, await point(app, `#${target} .universal-input .port-dot`));
}

async function expectGraph(app, count, connections) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===${count}&&document.value.connections.length===${connections.length}&&${JSON.stringify(connections)}.every((edge,index)=>document.value.connections[index]?.from.nodeId===edge.from.nodeId&&document.value.connections[index]?.from.port===edge.from.port&&document.value.connections[index]?.to.nodeId===edge.to.nodeId&&document.value.connections[index]?.to.port===edge.to.port))`);
    assert.deepEqual((await saved(app)).connections, connections);
}

async function history(app, key, feedback) {
    await app.evaluate(`(()=>{window.cameraHistorySeen=false;const observer=new MutationObserver(records=>{if(records.some(record=>Array.from(record.addedNodes).some(node=>node.textContent?.includes(${JSON.stringify(feedback)})))){window.cameraHistorySeen=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('cameraHistorySeen===true');
}

async function controlled(app, { held = false } = {}) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.cameraRequests=[];window.cameraPending=false;window.holdCameraSource=${held};const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){cameraRequests.push(body);if(holdCameraSource&&body.prompt.includes('held camera source')){cameraPending=true;await new Promise(resolve=>window.releaseCameraSource=resolve);}const images=${JSON.stringify(originals)},index=cameraRequests.length-1;return new Response(JSON.stringify({data:[{b64_json:images[index%images.length].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options);};` });
    await reloadAppBrowser(app);
}

async function action(app, id, actionId) {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById(${JSON.stringify(actionId)}).click()`);
}

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
}

test('camera universal image routing preserves occupied input and reversible explicit replacement and creation', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'first', type: 'ImageImport', x: 20, y: 150 },
        { id: 'second', type: 'ImageImport', x: 20, y: 440 },
        { id: 'text', type: 'Text', x: 380, y: 560, text: 'incompatible text' },
        { id: 'camera', type: 'CameraControl', x: 620, y: 150 }
    ], connections: [] }, async app => {
        await controlled(app);
        await app.waitFor("Boolean(document.querySelector('#camera .universal-input'))");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#camera .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#camera .node-port[data-direction=output]')].map(port=>port.dataset.port)"), ['text']);
        await connect(app, 'text', 'camera', 'text'); await delay(150); await expectGraph(app, 4, []);
        await connect(app, 'first');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===1)");
        const original = (await saved(app)).connections;
        assert.deepEqual([original[0].from, original[0].to, original[0].type], [{ nodeId: 'first', port: 'image' }, { nodeId: 'camera', port: 'image' }, 'image']);
        await connect(app, 'second');
        await app.waitFor("document.getElementById('toast-container').innerText.includes('已占用')"); await expectGraph(app, 4, original);
        await app.evaluate("document.getElementById('camera').click()");
        await app.waitFor("Boolean(document.querySelector('#image-parameter-panel [data-input-action=replace]'))");
        const row = `#image-parameter-panel [data-input-connection-id="${original[0].id}"]`;
        await app.evaluate(`(()=>{document.querySelector('${row} [data-input-action=replace]').click();const input=document.querySelector('${row} [data-input-replacement-source]');input.value=JSON.stringify({nodeId:'second',port:'image'});input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=cancel-replace]').click()})()`);
        await expectGraph(app, 4, original);
        await app.evaluate(`(()=>{document.querySelector('${row} [data-input-action=replace]').click();const input=document.querySelector('${row} [data-input-replacement-source]');input.value=JSON.stringify({nodeId:'second',port:'image'});input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=confirm-replace]').click()})()`);
        const replaced = [{ ...original[0], from: { nodeId: 'second', port: 'image' } }];
        await expectGraph(app, 4, replaced); await history(app, 'z', '已撤回'); await expectGraph(app, 4, original);
        await history(app, 'y', '已重做'); await expectGraph(app, 4, replaced);
        await drag(app, '#first .node-port[data-direction=output][data-port=image] .port-dot', { x: 300, y: 740 });
        await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
        await app.evaluate("document.querySelector('#connection-create-popup [data-popup-node-type=CameraControl]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===5&&document.value.connections.length===2)");
        const created = await saved(app), added = created.nodes.find(node => !['first', 'second', 'text', 'camera'].includes(node.id));
        assert.equal(added.type, 'CameraControl');
        assert.deepEqual(created.connections[1].to, { nodeId: added.id, port: 'image' });
        await history(app, 'z', '已撤回'); await expectGraph(app, 4, replaced);
        await history(app, 'y', '已重做'); await expectGraph(app, 5, created.connections);
        await history(app, 'z', '已撤回'); await expectGraph(app, 4, replaced);
        await app.evaluate(`document.getElementById('camera').click();document.querySelector('${row} [data-input-action=disconnect]').click()`);
        await expectGraph(app, 4, []);
        await drag(app, '#camera .universal-input .port-dot', { x: 300, y: 740 });
        await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
        await app.evaluate("document.querySelector('#connection-create-popup [data-popup-node-type=ImageImport]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===5&&document.value.connections.length===1)");
        const reverse = await saved(app), source = reverse.nodes.find(node => !['first', 'second', 'text', 'camera'].includes(node.id));
        assert.equal(source.type, 'ImageImport');
        assert.deepEqual([reverse.connections[0].from, reverse.connections[0].to], [{ nodeId: source.id, port: 'image' }, { nodeId: 'camera', port: 'image' }]);
        await history(app, 'z', '已撤回'); await expectGraph(app, 4, []);
        await history(app, 'y', '已重做'); await expectGraph(app, 5, reverse.connections);
        assert.equal(await app.evaluate('cameraRequests.length'), 0);
    });
});

test('the original camera editor keeps five controls and gestures and sends derived camera text with the first full-batch reference', { timeout: 90000 }, async () => {
    const input = { id: 'source-camera', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'camera', port: 'image' }, type: 'image', extension: { retained: true } };
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'source', type: 'ImageGenerate', x: 20, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'three camera references', generationCount: 3 },
        { id: 'camera', type: 'CameraControl', x: 450, y: 160, width: 345, height: 360, userResized: true, customTitle: '原独立视角编辑器', pitch: 0, yaw: 0, distance: 6.5, fov: 50, roll: 0 },
        { id: 'target', type: 'ImageGenerate', x: 850, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'MAIN PROMPT remains separate' },
        { id: 'sink', type: 'ImagePreview', x: 1250, y: 140 },
        { id: 'note', type: 'Text', x: 850, y: 620, text: 'unselected camera execution' }
    ], connections: [input, { id: 'target-preview', from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' }] }, async app => {
        await controlled(app);
        await action(app, 'source', 'context-menu-run-to-here');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='source')?.mediaAssetKeys?.length===3)");
        await app.waitFor("document.getElementById('btn-stop').disabled");
        const source = (await saved(app)).nodes.find(node => node.id === 'source');
        assert.equal(source.imagePreviewIndex, 2, 'the source is browsing its third item while the camera consumes its first item');
        const geometry = await app.evaluate("(()=>{const node=document.getElementById('camera');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
        await connect(app, 'camera', 'target', 'text');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===3)");
        const connections = (await saved(app)).connections;
        assert.deepEqual([connections[2].from, connections[2].to, connections[2].type], [{ nodeId: 'camera', port: 'text' }, { nodeId: 'target', port: 'camera_prompt' }, 'text']);
        await app.evaluate("document.getElementById('camera').click();document.querySelector('#image-parameter-panel [data-parameter-action=generate]').click()");
        await app.waitFor("Boolean(document.querySelector('.camera-control-stage canvas'))");
        assert.equal(await app.evaluate("Boolean(document.querySelector('.camera-control-stage canvas').getContext('webgl2')||document.querySelector('.camera-control-stage canvas').getContext('webgl'))"), true, 'the existing editor creates a real WebGL context');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.camera-control-editor-overlay [data-camera-value]')].map(input=>input.dataset.cameraValue)"), ['pitch', 'yaw', 'distance', 'fov', 'roll']);
        assert.equal(await app.evaluate("document.querySelector('.camera-control-editor-overlay .camera-control-prompt').readOnly"), true);
        await delay(250);
        await app.evaluate("document.querySelector('.camera-control-editor-close').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='camera')?.cameraPreviewImage?.startsWith('data:image/'))");
        const referencePixels = await app.evaluate("(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value,image=await createImageBitmap(await(await fetch(graph.nodes.find(node=>node.id==='camera').cameraPreviewImage)).blob()),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,image.width,image.height).data;let red=0,blue=0;for(let index=0;index<pixels.length;index+=4){if(pixels[index]>150&&pixels[index+1]<110&&pixels[index+2]<110)red++;if(pixels[index+2]>150&&pixels[index]<110&&pixels[index+1]<110)blue++;}return {red,blue,width:image.width,height:image.height}})()");
        assert.ok(referencePixels.red > 1000 && referencePixels.red > referencePixels.blue * 3, `the actual rendered reference uses the first red image, not the selected last image: ${JSON.stringify(referencePixels)}`);
        await app.evaluate("document.getElementById('camera-camera-open').click()");
        await app.waitFor("Boolean(document.querySelector('.camera-control-stage canvas'))");
        const stage = await point(app, '.camera-control-stage');
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...stage, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 40, y: stage.y + 20, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 40, y: stage.y + 20, button: 'left', clickCount: 1 });
        assert.deepEqual(await app.evaluate("['pitch','yaw'].map(key=>Number(document.querySelector('[data-camera-value='+key+']').value))"), [5, -14], 'first-person dragging edits the camera without moving the canvas node');
        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...stage, deltaX: 0, deltaY: 100 });
        await app.waitFor("Number(document.querySelector('[data-camera-value=distance]').value)>6.5");
        const expected = { pitch: 20, yaw: -35, distance: 8.5, fov: 65, roll: 15, cameraViewMode: 'thirdPerson' };
        await app.evaluate(`(()=>{for(const [key,value] of Object.entries(${JSON.stringify(expected)})){const input=document.querySelector('[data-camera-value='+key+']');if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}}document.querySelector('[data-camera-view-mode=thirdPerson]').click()})()`);
        const beforeObserver = await app.evaluate("[...document.querySelectorAll('[data-camera-value]')].map(input=>input.value)");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...stage, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 35, y: stage.y - 15, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 35, y: stage.y - 15, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...stage, deltaX: 0, deltaY: 120 });
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('[data-camera-value]')].map(input=>input.value)"), beforeObserver, 'third-person orbit and zoom change only the observer');
        await app.evaluate("document.querySelector('.camera-control-editor-close').click();document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('note').click()");
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='camera');return Object.entries(${JSON.stringify(expected)}).every(([key,value])=>node?.[key]===value)})`);
        const camera = (await saved(app)).nodes.find(node => node.id === 'camera');
        assert.match(camera.cameraPrompt, /20°/); assert.match(camera.cameraPrompt, /35°/); assert.match(camera.cameraPrompt, /65°/);
        await action(app, 'target', 'context-menu-run-to-here');
        await app.waitFor("cameraRequests.length===7 && document.getElementById('btn-stop').disabled");
        const requests = await app.evaluate('cameraRequests');
        assert.ok(requests.at(-1).prompt.includes('MAIN PROMPT remains separate'));
        assert.ok(requests.at(-1).prompt.includes(camera.cameraPrompt), 'the provider receives the exact derived camera text through its own input role');
        const after = await saved(app);
        assert.deepEqual(cameraValues(after.nodes.find(node => node.id === 'camera')), expected);
        assert.equal(after.nodes.find(node => node.id === 'target').prompt, 'MAIN PROMPT remains separate');
        assert.deepEqual(after.connections, connections);
        assert.deepEqual(after.nodes.find(node => node.id === 'source').mediaAssetKeys, source.mediaAssetKeys);
        assert.equal(after.nodes.find(node => node.id === 'source').imagePreviewIndex, source.imagePreviewIndex);
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('camera');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()"), geometry);
        await app.evaluate("document.getElementById('btn-save-workflow').click()");
        await app.waitFor("document.getElementById('toolbar-workflow-status').dataset.state==='saved'");
        const sourceOwner = await app.evaluate("(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value;return (await fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(graph.activeWorkflowId)).then(response=>response.json())).owners.find(owner=>owner.ownerType==='workflow-node'&&owner.ownerId==='source')})()");
        assert.ok(source.mediaAssetKeys.every(key => sourceOwner.assetKeys.includes(key)), 'using a single camera reference retains ownership of every source original');
        await reloadAppBrowser(app);
        const restored = await saved(app);
        assert.deepEqual(cameraValues(restored.nodes.find(node => node.id === 'camera')), expected);
        assert.equal(restored.nodes.find(node => node.id === 'camera').cameraPrompt, camera.cameraPrompt);
        assert.equal(restored.nodes.find(node => node.id === 'camera').customTitle, '原独立视角编辑器');
        assert.deepEqual(restored.nodes.find(node => node.id === 'source').mediaAssetKeys, source.mediaAssetKeys);
        assert.equal(restored.nodes.find(node => node.id === 'source').imagePreviewIndex, source.imagePreviewIndex);
        assert.deepEqual(restored.connections, connections);
        await app.evaluate("document.getElementById('camera-camera-open').click()");
        await app.waitFor("Boolean(document.querySelector('.camera-control-stage canvas'))");
        assert.deepEqual(await app.evaluate("Object.fromEntries([...document.querySelectorAll('[data-camera-value]')].map(input=>[input.dataset.cameraValue,Number(input.value)]))"), { pitch: 20, yaw: -35, distance: 8.5, fov: 65, roll: 15 });
        assert.equal(await app.evaluate("document.querySelector('[data-camera-view-mode=thirdPerson]').getAttribute('aria-pressed')"), 'true');
        assert.equal(await app.evaluate('cameraRequests.length'), 0);
    });
});

test('a delayed original editor load cannot open or save into a different workflow with the same camera ID', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app);
        const graphs = [
            { name: 'Camera A', workflowId: 'camera-load-a', nodes: [{ id: 'camera', type: 'CameraControl', x: 440, y: 160, pitch: 11, yaw: 22, distance: 6.5, fov: 48, roll: 3, cameraViewMode: 'firstPerson' }], connections: [] },
            { name: 'Camera B', workflowId: 'camera-load-b', nodes: [{ id: 'camera', type: 'CameraControl', x: 540, y: 210, pitch: -18, yaw: -75, distance: 9.5, fov: 72, roll: -12, cameraViewMode: 'thirdPerson' }], connections: [] }
        ];
        for (const graph of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(graph.name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Camera A');
        await app.send('Network.enable');
        await app.send('Network.setCacheDisabled', { cacheDisabled: true });
        await app.evaluate('performance.setResourceTimingBufferSize(5000);performance.clearResourceTimings()');
        await app.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 4096, uploadThroughput: 1048576 });
        try {
            await app.evaluate("document.getElementById('camera-camera-open').click()");
            assert.equal(await app.evaluate("Boolean(document.querySelector('.camera-control-editor-overlay'))"), false, 'the real lazy module is still loading under constrained network throughput');
            await activate(app, 'Camera B');
            await app.evaluate('window.cameraBActivatedAt=performance.now()');
        } finally {
            await app.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        }
        const moduleLoaded = "performance.getEntriesByType('resource').some(entry=>new URL(entry.name).pathname.endsWith('/camera-control-node.js'))";
        for (let attempt = 0; attempt < 600 && !(await app.evaluate(moduleLoaded)); attempt++) await delay(50);
        assert.equal(await app.evaluate(moduleLoaded), true, 'the delayed real editor module finishes loading');
        assert.equal(await app.evaluate("performance.getEntriesByType('resource').find(entry=>new URL(entry.name).pathname.endsWith('/camera-control-node.js')).responseEnd>cameraBActivatedAt"), true, 'the original module actually finishes after B becomes active');
        await delay(500);
        assert.equal(await app.evaluate("Boolean(document.querySelector('.camera-control-editor-overlay'))"), false, 'finishing the previous workflow request must not open an editor for the same ID in B');
        const before = (await saved(app)).nodes.find(node => node.id === 'camera');
        assert.deepEqual(cameraValues(before), cameraValues(graphs[1].nodes[0]));
        assert.equal(before.cameraPreviewImage || '', '');
        await app.evaluate("document.getElementById('camera-camera-open').click()");
        await app.waitFor("Boolean(document.querySelector('.camera-control-stage canvas'))");
        assert.equal(await app.evaluate("Number(document.querySelector('[data-camera-value=yaw]').value)"), -75);
        await app.evaluate("document.querySelector('.camera-control-editor-close').click()");
        await activate(app, 'Camera A');
        assert.deepEqual(cameraValues((await saved(app)).nodes.find(node => node.id === 'camera')), cameraValues(graphs[0].nodes[0]));
        assert.equal((await saved(app)).nodes.find(node => node.id === 'camera').cameraPreviewImage || '', '');
        assert.equal(await app.evaluate('cameraRequests.length'), 0);
    });
});

test('background camera execution uses A settings while a same-ID B camera and clone controls remain protected', { timeout: 90000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app, { held: true });
        const graphs = [
            { name: 'Run Camera A', workflowId: 'camera-run-a', nodes: [
                { id: 'source', type: 'ImageGenerate', x: 20, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'held camera source' },
                { id: 'camera', type: 'CameraControl', x: 440, y: 160, pitch: 25, yaw: 40, distance: 7.5, fov: 60, roll: 8, cameraViewMode: 'thirdPerson' },
                { id: 'target', type: 'ImageGenerate', x: 850, y: 140, apiConfigId: 'image', providerId: 'p', prompt: 'A actual background camera' },
                { id: 'sink', type: 'ImagePreview', x: 1250, y: 140 }
            ], connections: [
                { id: 'image-camera', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'camera', port: 'image' }, type: 'image' },
                { id: 'camera-target', from: { nodeId: 'camera', port: 'text' }, to: { nodeId: 'target', port: 'camera_prompt' }, type: 'text' },
                { id: 'target-preview', from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' }
            ] },
            { name: 'Run Camera B', workflowId: 'camera-run-b', nodes: [
                { id: 'camera', type: 'CameraControl', x: 540, y: 210, pitch: -32, yaw: -110, distance: 11, fov: 78, roll: -20, cameraViewMode: 'firstPerson' }
            ], connections: [] }
        ];
        for (const graph of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(graph.name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Run Camera A');
        const before = (await saved(app)).nodes.find(node => node.id === 'camera');
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor('cameraPending===true');
        await app.evaluate("document.getElementById('camera-camera-open').click()");
        await delay(150);
        assert.equal(await app.evaluate("Boolean(document.querySelector('.camera-control-editor-overlay'))"), false, 'the camera cannot bypass its runtime edit lock while waiting on its source');
        await activate(app, 'Run Camera B');
        const b = (await saved(app)).nodes.find(node => node.id === 'camera');
        assert.deepEqual(cameraValues(b), cameraValues(graphs[1].nodes[0]));
        await app.evaluate('holdCameraSource=false;releaseCameraSource()');
        await app.waitFor("cameraRequests.length===2 && document.querySelector('.workflow-item[data-name=\"Run Camera A\"]')?.classList.contains('is-running')===false");
        const request = await app.evaluate('cameraRequests.at(-1)');
        assert.ok(request.prompt.includes('A actual background camera'));
        assert.ok(request.prompt.includes(before.cameraPrompt), 'background generation uses A derived settings after B becomes active');
        assert.ok(!request.prompt.includes(b.cameraPrompt));
        assert.deepEqual(cameraValues((await saved(app)).nodes.find(node => node.id === 'camera')), cameraValues(b));
        assert.equal((await saved(app)).nodes.find(node => node.id === 'camera').cameraPreviewImage || '', '');
        await activate(app, 'Run Camera A');
        const after = await saved(app);
        assert.deepEqual(cameraValues(after.nodes.find(node => node.id === 'camera')), cameraValues(before));
        assert.equal(after.nodes.find(node => node.id === 'camera').cameraPrompt, before.cameraPrompt);
        assert.ok(after.nodes.find(node => node.id === 'target').mediaAssetKeys?.length === 1);
        assert.equal(after.nodes.find(node => node.id === 'source').mediaAssetKeys?.length, 1);
        assert.deepEqual(after.connections, graphs[0].connections);
        await action(app, 'camera', 'context-menu-clone-node');
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=true;document.getElementById('btn-confirm-clone-node-count').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===5)");
        const cloned = await saved(app), clone = cloned.nodes.find(node => node.cloneSourceId === 'camera');
        assert.ok(clone?.isClone);
        assert.deepEqual(cameraValues(clone), cameraValues(before));
        await app.evaluate(`document.getElementById(${JSON.stringify(clone.id)}).click()`);
        await app.waitFor(`document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(clone.id)}`);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').disabled"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-action=disconnect]').disabled"), false, 'clone camera parameters are read-only while reference connection controls retain their permission');
        await app.evaluate(`document.getElementById('${clone.id}-camera-open').click()`);
        await delay(150);
        assert.equal(await app.evaluate("Boolean(document.querySelector('.camera-control-editor-overlay'))"), false);
        assert.equal(await app.evaluate('cameraRequests.length'), 2);
    });
});
