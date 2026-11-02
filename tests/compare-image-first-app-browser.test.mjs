import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const originals = Object.fromEntries(await Promise.all(['red', 'blue', 'orange'].map(async color => [color,
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')])));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const edge = (id, source, port, extra = {}) => ({ id, from: { nodeId: source, port: 'image' }, to: { nodeId: 'compare', port }, type: 'image', ...extra });

async function openInputs(app) {
    await app.evaluate("document.getElementById('compare').click()");
    await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='compare'");
    await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]');if(toggle && toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()");
}

async function closeInputs(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
}

async function upload(app, id, color) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(originals[color])})).blob()],'${color}.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='${id}')?.mediaAssetKeys?.length===1)`);
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect(),direction=element.closest('.node-port')?.dataset.direction;return {x:rect.x+rect.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:rect.y+rect.height/2}})()`);
}

async function connect(app, source) {
    await closeInputs(app);
    const from = await point(app, `#${source} .node-port[data-direction=output][data-port=image] .port-dot`);
    const to = await point(app, '#compare .universal-input .port-dot');
    assert.ok(await app.evaluate(`Boolean(document.elementFromPoint(${from.x},${from.y})?.closest('.node-port'))`), `the source output port is reachable at ${JSON.stringify(from)}: ${await app.evaluate(`document.elementFromPoint(${from.x},${from.y})?.outerHTML.slice(0,500)`)}`);
    assert.ok(await app.evaluate(`document.elementFromPoint(${to.x},${to.y})?.closest('.universal-input')`), 'the compare universal port is reachable');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 35, y: from.y + 15, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
}

async function history(app, key, text) {
    await app.evaluate(`(()=>{window.compareHistorySeen=false;const observer=new MutationObserver(records=>{const added=records.flatMap(record=>Array.from(record.addedNodes));if(added.some(node=>node.textContent?.includes(${JSON.stringify(text)}))){window.compareHistorySeen=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('compareHistorySeen===true');
}

async function expectConnections(app, expected) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const actual=document.value?.connections;return actual?.length===${expected.length}&&${JSON.stringify(expected)}.every((edge,index)=>actual[index]?.id===edge.id&&actual[index]?.from.nodeId===edge.from.nodeId&&actual[index]?.from.port===edge.from.port&&actual[index]?.to.nodeId===edge.to.nodeId&&actual[index]?.to.port===edge.to.port)})`);
    assert.deepEqual((await saved(app)).connections, expected);
}

async function pixel(app, selector) {
    await app.waitFor(`document.querySelector(${JSON.stringify(selector)})?.naturalWidth>0`);
    return app.evaluate(`(async()=>{const image=document.querySelector(${JSON.stringify(selector)}),bitmap=await createImageBitmap(await(await fetch(image.src)).blob()),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);return {width:bitmap.width,height:bitmap.height,pixel:Array.from(context.getImageData(Math.floor(bitmap.width/4),Math.floor(bitmap.height/2),1,1).data)};})()`);
}

function assertColor(actual, expected, message) {
    // Display previews may be JPEG thumbnails; media identity assertions below
    // still compare the original asset keys without any lossy tolerance.
    assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 2), message || `expected ${actual} to display ${expected}`);
}

async function displayed(app, selector, expected) {
    await app.waitFor(`(()=>{const image=document.querySelector(${JSON.stringify(selector)});if(!image?.complete||!image.naturalWidth)return false;const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,-Math.floor(image.naturalWidth/4),-Math.floor(image.naturalHeight/2));return Array.from(context.getImageData(0,0,1,1).data).every((channel,index)=>Math.abs(channel-${JSON.stringify(expected)}[index])<=2)})()`);
    assertColor((await pixel(app, selector)).pixel, expected);
}

async function output(app) {
    await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='compare')?.mediaAssetKeys?.length===1)");
    return app.evaluate("(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value,node=graph.nodes.find(node=>node.id==='compare'),key=node.mediaAssetKeys[0],blob=await(await fetch('/api/storage/assets/'+encodeURIComponent(key))).blob(),bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);return {key,width:bitmap.width,height:bitmap.height,pixel:Array.from(context.getImageData(Math.floor(bitmap.width/4),Math.floor(bitmap.height/2),1,1).data)};})()");
}

async function run(app, id = '') {
    if (id) await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:200}));document.getElementById('context-menu-run-to-here').click()`);
    else await app.evaluate("document.getElementById('btn-run').click()");
    await app.waitFor("document.getElementById('btn-stop').disabled && !document.getElementById('btn-run').disabled");
}

async function controlled(app, { held = false } = {}) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.compareRequests=[];window.comparePending=false;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){const index=compareRequests.filter(request=>request.prompt===body.prompt).length;compareRequests.push(body);if(${held}){comparePending=true;await new Promise(resolve=>window.releaseCompareImage=resolve);}const images=${JSON.stringify(originals)},sequence=body.prompt==='source-a'?['red','blue','orange']:['blue','orange','red'];return new Response(JSON.stringify({data:[{b64_json:images[sequence[index%3]].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options);};` });
    await reloadAppBrowser(app);
}

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor("Boolean(document.getElementById('compare-compare'))");
}

test('the universal compare input fills A then B, refuses a full target and explicitly replaces one reversible connection', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        ...['first', 'second', 'replacement'].map((id, index) => ({ id, type: 'ImageImport', x: 25, y: 140 + index * 230 })),
        { id: 'compare', type: 'ImageCompare', x: 550, y: 180, width: 350, height: 370, userResized: true }
    ], connections: [] }, async app => {
        await app.waitFor("Boolean(document.querySelector('#compare .universal-input'))");
        await upload(app, 'first', 'red'); await upload(app, 'second', 'blue'); await upload(app, 'replacement', 'orange');
        await connect(app, 'first');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===1)");
        const first = (await saved(app)).connections[0];
        assert.deepEqual(first.to, { nodeId: 'compare', port: 'imageA' });
        await connect(app, 'second');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===2)");
        const full = (await saved(app)).connections;
        assert.deepEqual(full.map(connection => [connection.from.nodeId, connection.to.port]), [['first', 'imageA'], ['second', 'imageB']]);
        const retained = await output(app);
        await connect(app, 'replacement');
        await app.waitFor("document.getElementById('toast-container').innerText.match(/已占用|已满|空闲|满位/)");
        assert.deepEqual((await saved(app)).connections, full, 'a third automatic connection cannot overwrite A or B');
        assert.equal((await output(app)).key, retained.key);
        await openInputs(app);
        const row = `#image-parameter-panel [data-input-connection-id="${first.id}"]`;
        await app.evaluate(`document.querySelector('${row} [data-input-action=replace]').click();const source=document.querySelector('${row} [data-input-replacement-source]');source.value=JSON.stringify({nodeId:'replacement',port:'image'});source.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=confirm-replace]').click()`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(connection=>connection.id===${JSON.stringify(first.id)})?.from.nodeId==='replacement')`);
        const replaced = [{ ...first, from: { nodeId: 'replacement', port: 'image' } }, full[1]];
        assert.deepEqual((await saved(app)).connections, replaced);
        const replacementColor = (await pixel(app, '#replacement-drop img')).pixel;
        await displayed(app, '#compare-compare .image-compare-a', replacementColor);
        await history(app, 'z', '已撤回');
        await expectConnections(app, full);
        await displayed(app, '#compare-compare .image-compare-a', [255, 0, 0, 255]);
        await history(app, 'y', '已重做');
        await expectConnections(app, replaced);
        await displayed(app, '#compare-compare .image-compare-a', replacementColor);
        await displayed(app, '#compare-compare .image-compare-b', [0, 0, 255, 255]);
    });
});

test('real A/B swap preserves full source batches and connection metadata with one undo and redo and no generation', { timeout: 60000 }, async () => {
    const connections = [
        edge('preserved-a', 'source-a', 'imageA', { order: 4, extension: { token: 'keep A' } }),
        edge('preserved-b', 'source-b', 'imageB', { order: 9, extension: { token: 'keep B' } })
    ];
    await withAppBrowser({ ...configuration, nodes: [
        ...['source-a', 'source-b'].map((id, index) => ({ id, type: 'ImageGenerate', x: 20, y: 20 + index * 330, apiConfigId: 'image', providerId: 'p', prompt: id, generationCount: 3 })),
        { id: 'compare', type: 'ImageCompare', x: 550, y: 90, width: 350, height: 370, userResized: true, customTitle: '保留对比标题' }
    ], connections }, async app => {
        await controlled(app); await run(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>['source-a','source-b'].every(id=>document.value?.nodes.find(node=>node.id===id)?.mediaAssetKeys?.length===3))");
        const before = await saved(app);
        await displayed(app, '#compare-compare .image-compare-a', [255, 0, 0, 255]);
        await displayed(app, '#compare-compare .image-compare-b', [0, 0, 255, 255]);
        assert.equal((await output(app)).key, before.nodes.find(node => node.id === 'source-b').mediaAssetKeys[0]);
        await openInputs(app);
        assert.match(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-connection-id=preserved-a]').textContent"), /3\s*张/);
        assert.match(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-connection-id=preserved-b]').textContent"), /3\s*张/);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-input-action=swap]').click()");
        const swapped = connections.map(connection => ({ ...connection, to: { ...connection.to, port: connection.to.port === 'imageA' ? 'imageB' : 'imageA' } }));
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.find(connection=>connection.id==='preserved-a')?.to.port==='imageB')");
        assert.deepEqual((await saved(app)).connections, swapped, 'swap changes actual roles while retaining edge identity, source, order and extension fields');
        await displayed(app, '#compare-compare .image-compare-a', [0, 0, 255, 255]);
        await displayed(app, '#compare-compare .image-compare-b', [255, 0, 0, 255]);
        const primaryA = before.nodes.find(node => node.id === 'source-a').mediaAssetKeys[0];
        const primaryB = before.nodes.find(node => node.id === 'source-b').mediaAssetKeys[0];
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='compare')?.mediaAssetKeys?.[0]===${JSON.stringify(primaryA)})`);
        assert.equal((await output(app)).key, primaryA, 'swapping the real B role also changes the persisted output identity');
        await history(app, 'z', '已撤回');
        await expectConnections(app, connections);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='compare')?.mediaAssetKeys?.[0]===${JSON.stringify(primaryB)})`);
        await history(app, 'y', '已重做');
        await expectConnections(app, swapped);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='compare')?.mediaAssetKeys?.[0]===${JSON.stringify(primaryA)})`);
        assert.equal(await app.evaluate('compareRequests.length'), 6, 'swap and history never regenerate either complete batch');
        const after = await saved(app);
        for (const id of ['source-a', 'source-b']) assert.deepEqual(after.nodes.find(node => node.id === id).mediaAssetKeys, before.nodes.find(node => node.id === id).mediaAssetKeys);
        await closeInputs(app);
        const rect = await app.evaluate("(()=>{const rect=document.getElementById('compare-compare').getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.width * 0.27, y: rect.y + rect.height * 0.5 });
        await app.waitFor("Math.abs(parseFloat(document.getElementById('compare-compare').style.getPropertyValue('--compare-x'))-27)<1");
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false, 'moving the divider does not trigger the image viewer');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>Math.abs(document.value?.nodes.find(node=>node.id==='compare')?.comparePosition-27)<1)");
        await reloadAppBrowser(app);
        assert.ok(Math.abs(await app.evaluate("parseFloat(document.getElementById('compare-compare').style.getPropertyValue('--compare-x'))") - 27) < 1);
        assert.deepEqual((await saved(app)).connections, swapped);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'compare').customTitle, '保留对比标题');
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('compare');return [node.style.left,node.style.top,node.offsetWidth]})()"), ['550px', '90px', 350]);
        assert.equal(await app.evaluate('compareRequests.length'), 0);
    });
});

test('a B-only compare runs and missing B retains a visibly stale original while rejecting a new execution', { timeout: 45000 }, async () => {
    const connection = edge('only-b', 'b-source', 'imageB');
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'b-source', type: 'ImageImport', x: 30, y: 30 },
        { id: 'compare', type: 'ImageCompare', x: 550, y: 80, width: 350, height: 370, userResized: true }
    ], connections: [connection] }, async app => {
        await upload(app, 'b-source', 'blue'); await closeInputs(app); await run(app);
        const before = await output(app);
        assert.deepEqual(before.pixel, [0, 0, 255, 255]);
        assert.equal(await app.evaluate("Boolean(document.querySelector('#compare-compare .image-compare-a'))"), false);
        await openInputs(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-input-connection-id=only-b] [data-input-action=disconnect]').click()");
        await app.waitFor("document.getElementById('compare-compare').dataset.compareState==='stale'");
        await app.waitFor("document.getElementById('compare').innerText.includes('未更新')");
        await expectConnections(app, []);
        assert.equal((await output(app)).key, before.key);
        await displayed(app, '#compare-compare .image-compare-b', before.pixel);
        await closeInputs(app); await run(app, 'compare');
        await app.waitFor("document.querySelector('#compare .node-failure-summary')?.textContent.match(/B.*输入|输入.*B/)");
        assert.equal((await output(app)).key, before.key, 'failed validation cannot erase the retained old B original');
        await expectConnections(app, []);
        await reloadAppBrowser(app);
        assert.equal((await output(app)).key, before.key);
        await displayed(app, '#compare-compare .image-compare-b', before.pixel);
    });
});

test('a background A/B comparison retains its split and media owners while a same-ID compare is active elsewhere', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app, { held: true });
        const graphs = [
            { name: 'Compare A', workflowId: 'compare-background-a', nodes: [
                { id: 'a-source', type: 'ImageImport', x: 20, y: 20 },
                { id: 'source-b', type: 'ImageGenerate', x: 20, y: 350, apiConfigId: 'image', providerId: 'p', prompt: 'source-b' },
                { id: 'compare', type: 'ImageCompare', x: 550, y: 90, width: 350, height: 370, userResized: true, comparePosition: 27 }
            ], connections: [edge('background-a', 'a-source', 'imageA'), edge('background-b', 'source-b', 'imageB')] },
            { name: 'Compare B', workflowId: 'compare-background-b', nodes: [
                { id: 'compare', type: 'ImageCompare', x: 550, y: 90, width: 350, height: 370, userResized: true, comparePosition: 73 }
            ], connections: [] }
        ];
        for (const { name, ...graph } of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Compare A');
        await upload(app, 'a-source', 'red');
        await openInputs(app); await closeInputs(app);
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor('comparePending===true');
        await activate(app, 'Compare B');
        assert.equal(await app.evaluate("document.querySelector('.workflow-item[data-name=\"Compare A\"]').classList.contains('is-running')"), true);
        assert.equal(await app.evaluate("parseFloat(document.getElementById('compare-compare').style.getPropertyValue('--compare-x'))"), 73);
        await app.evaluate('releaseCompareImage()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Compare A\"]').classList.contains('is-running')");
        const other = await saved(app);
        assert.equal(other.activeWorkflowId, 'compare-background-b');
        assert.deepEqual(other.connections, []);
        assert.equal(other.nodes.find(node => node.id === 'compare').comparePosition, 73);
        assert.ok(!other.nodes.find(node => node.id === 'compare').mediaAssetKeys?.length, 'background completion cannot assign its output to the visible same-ID compare');
        await activate(app, 'Compare A');
        await displayed(app, '#compare-compare .image-compare-a', [255, 0, 0, 255]);
        await displayed(app, '#compare-compare .image-compare-b', [0, 0, 255, 255]);
        const result = await output(app), completed = await saved(app);
        assert.equal(result.key, completed.nodes.find(node => node.id === 'source-b').mediaAssetKeys[0]);
        assert.deepEqual(completed.connections, graphs[0].connections);
        assert.equal(completed.nodes.find(node => node.id === 'compare').comparePosition, 27);
        assert.equal(await app.evaluate("parseFloat(document.getElementById('compare-compare').style.getPropertyValue('--compare-x'))"), 27);
        assert.equal(await app.evaluate('compareRequests.length'), 1, 'returning to the background result reuses its retained original');
        await waitForAutosave(app);
        const owners = await app.evaluate("Promise.all(['compare-background-a','compare-background-b'].map(id=>fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(id)).then(response=>response.json()).then(result=>result.owners.filter(owner=>owner.ownerType==='workflow-node'&&owner.ownerId==='compare'))))");
        assert.deepEqual(owners[0][0]?.assetKeys, [result.key]);
        assert.ok(owners[1].every(owner => !owner.assetKeys.length));
        await reloadAppBrowser(app);
        assert.equal((await output(app)).key, result.key);
        assert.equal(await app.evaluate("parseFloat(document.getElementById('compare-compare').style.getPropertyValue('--compare-x'))"), 27);
        await activate(app, 'Compare B');
        assert.equal((await saved(app)).nodes.find(node => node.id === 'compare').comparePosition, 73);
        assert.ok(!(await saved(app)).nodes.find(node => node.id === 'compare').mediaAssetKeys?.length);
    });
});
