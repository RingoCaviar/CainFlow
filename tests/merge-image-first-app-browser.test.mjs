import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const originals = Object.fromEntries(await Promise.all(['red', 'blue', 'orange', 'green', 'yellow'].map(async color => [color,
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')])));
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const edge = (id, source, port, extra = {}) => ({ id, from: { nodeId: source, port: 'image' }, to: { nodeId: 'merge', port }, type: 'image', ...extra });
const sourceKeys = (graph, id) => graph.nodes.find(node => node.id === id).mediaAssetKeys;

async function openInputs(app, id = 'merge') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
    await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]');if(toggle&&toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()");
}

async function closeInputs(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
}

async function action(app, id, menu) {
    await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById('${menu}').click()`);
}

async function shortcut(app, key) {
    await app.evaluate(`(()=>{const canvas=document.getElementById('canvas-container');canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}))})()`);
}

async function history(app, key, feedback) {
    await app.evaluate(`(()=>{window.mergeHistorySeen=false;const observer=new MutationObserver(records=>{const added=records.flatMap(record=>Array.from(record.addedNodes));if(added.some(node=>node.textContent?.includes(${JSON.stringify(feedback)}))){window.mergeHistorySeen=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('mergeHistorySeen===true');
}

async function expectConnections(app, expected) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const actual=document.value?.connections;return actual?.length===${expected.length}&&${JSON.stringify(expected)}.every((edge,index)=>actual[index]?.id===edge.id&&actual[index]?.from.nodeId===edge.from.nodeId&&actual[index]?.from.port===edge.from.port&&actual[index]?.to.nodeId===edge.to.nodeId&&actual[index]?.to.port===edge.to.port)})`);
    assert.deepEqual((await saved(app)).connections, expected);
}

async function expectKeys(app, expected, id = 'merge') {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>JSON.stringify(document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys)===${JSON.stringify(JSON.stringify(expected))})`).catch(async error => {
        const actual = (await saved(app)).nodes.map(({ id, mediaAssetKeys, imageAssetKey, imageImportAssetKey }) => ({ id, mediaAssetKeys, imageAssetKey, imageImportAssetKey }));
        throw new Error(`${error.message}\nSaved media identities: ${JSON.stringify(actual)}`, { cause: error });
    });
    assert.deepEqual(sourceKeys(await saved(app), id), expected);
}

async function controlled(app, { held = false } = {}) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.mergeRequests=[];window.mergePending=false;window.mergeHoldRequests=${held};const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){const index=mergeRequests.filter(request=>request.prompt===body.prompt).length;mergeRequests.push(body);if(mergeHoldRequests){mergePending=true;await new Promise(resolve=>window.releaseMergeImage=resolve);}const images=${JSON.stringify(originals)},sequences={'source-a':['red','orange','blue'],'source-b':['blue','green','orange'],'source-c':['yellow','red','green']},sequence=sequences[body.prompt]||sequences['source-b'];return new Response(JSON.stringify({data:[{b64_json:images[sequence[index%sequence.length]].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options);};` });
    await reloadAppBrowser(app);
}

async function upload(app, id, color) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(originals[color])})).blob()],'${color}.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='${id}')?.mediaAssetKeys?.length===1)`);
}

async function run(app) {
    await app.evaluate("document.getElementById('btn-run').click()");
    await app.waitFor("document.getElementById('btn-stop').disabled && !document.getElementById('btn-run').disabled");
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect(),direction=element.closest('.node-port')?.dataset.direction;return {x:rect.x+rect.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:rect.y+rect.height/2}})()`);
}

async function connect(app, source) {
    await closeInputs(app);
    const from = await point(app, `#${source} .node-port[data-direction=output][data-port=image] .port-dot`), to = await point(app, '#merge .universal-input .port-dot');
    assert.ok(await app.evaluate(`Boolean(document.elementFromPoint(${from.x},${from.y})?.closest('.node-port'))`), 'source output is reachable');
    assert.ok(await app.evaluate(`Boolean(document.elementFromPoint(${to.x},${to.y})?.closest('.universal-input'))`), 'merge universal input is reachable');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 35, y: from.y + 15, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
}

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor("Boolean(document.getElementById('merge'))");
}

async function browse(app, index, count) {
    await app.evaluate("document.querySelector('#merge-merge-preview .image-save-preview-counter').click()");
    await app.waitFor(`document.querySelectorAll('#merge-merge-preview [data-preview-batch-index]').length===${count}`);
    await app.evaluate(`document.querySelector('#merge-merge-preview [data-preview-batch-index="${index}"]').click()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='merge')?.imagePreviewIndex===${index})`);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
}

test('sparse numeric merge inputs concatenate complete source batches and reversible source moves change the real output order', { timeout: 90000 }, async () => {
    const connections = [
        edge('edge-c', 'source-c', 'image_10', { order: 2, extension: { token: 'C' } }),
        edge('edge-a', 'source-a', 'image_2', { order: 8, extension: { token: 'A' } }),
        edge('edge-b', 'source-b', 'image_7', { order: 5, extension: { token: 'B' } })
    ];
    await withAppBrowser({ ...configuration, nodes: [
        ...['source-a', 'source-b', 'source-c'].map((id, index) => ({ id, type: 'ImageGenerate', x: 20, y: 120 + index * 300, apiConfigId: 'image', providerId: 'p', prompt: id, generationCount: 3 })),
        { id: 'merge', type: 'ImageMerge', x: 500, y: 100, width: 350, height: 360, userResized: true, inputCount: 11, customTitle: '保留完整批次' },
        { id: 'sink', type: 'ImagePreview', x: 900, y: 100 }
    ], connections: [...connections, { id: 'merged-output', from: { nodeId: 'merge', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' }] }, async app => {
        await controlled(app);
        await app.waitFor("Boolean(document.querySelector('#merge .universal-input'))");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#merge .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        await run(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>['source-a','source-b','source-c'].every(id=>document.value?.nodes.find(node=>node.id===id)?.mediaAssetKeys?.length===3))");
        const before = await saved(app), a = sourceKeys(before, 'source-a'), b = sourceKeys(before, 'source-b'), c = sourceKeys(before, 'source-c');
        const original = [...a, ...b, ...c], reordered = [...a, ...c, ...b];
        await expectKeys(app, original); await expectKeys(app, original, 'sink');
        const geometry = await app.evaluate("(()=>{const node=document.getElementById('merge');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
        await openInputs(app);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-input-connection-id]')].map(row=>row.dataset.inputConnectionId)"), ['edge-a', 'edge-b', 'edge-c']);
        for (const id of ['edge-a', 'edge-b', 'edge-c']) assert.match(await app.evaluate(`document.querySelector('[data-input-connection-id=${id}]').textContent`), /3\s*张/);
        await app.evaluate("document.querySelector('[data-input-connection-id=edge-c] [data-input-action=move-up]').click()");
        const swapped = connections.map(connection => ({ ...connection, to: { ...connection.to, port: connection.id === 'edge-c' ? 'image_7' : connection.id === 'edge-b' ? 'image_10' : connection.to.port } }));
        const outgoing = before.connections.find(connection => connection.id === 'merged-output');
        await expectConnections(app, [...swapped, outgoing]); await expectKeys(app, reordered);
        await history(app, 'z', '已撤回'); await expectConnections(app, before.connections); await expectKeys(app, original);
        await history(app, 'y', '已重做'); await expectConnections(app, [...swapped, outgoing]); await expectKeys(app, reordered);
        await openInputs(app);
        await app.evaluate("document.querySelector('[data-input-connection-id=edge-c] [data-input-action=move-down]').click()");
        await expectConnections(app, before.connections); await expectKeys(app, original);
        assert.equal(await app.evaluate('mergeRequests.length'), 9, 'moving sources and graph history never regenerate any batch');
        await closeInputs(app);
        await app.evaluate("document.querySelector('#merge-merge-preview .image-save-preview-counter').click()");
        await app.waitFor("document.querySelectorAll('#merge-merge-preview [data-preview-batch-index]').length===9");
        await app.evaluate("document.querySelector('#merge-merge-preview [data-preview-batch-index=\"8\"]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='merge')?.imagePreviewIndex===8)");
        await expectKeys(app, original);
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('merge');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()"), geometry);
        await app.evaluate("(()=>{window.mergeDownstreamFinished=false;const observer=new MutationObserver(records=>{if(records.some(record=>Array.from(record.addedNodes).some(node=>node.textContent?.includes('工作流运行完成')))){window.mergeDownstreamFinished=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true})})()");
        await app.evaluate("document.getElementById('sink').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:950,clientY:240}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:950,clientY:240}));document.getElementById('sink').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:950,clientY:240}));document.getElementById('context-menu-run-selected').click()");
        await app.waitFor('mergeDownstreamFinished===true');
        await expectKeys(app, original, 'sink');
        assert.equal(await app.evaluate('mergeRequests.length'), 9, 'running the downstream preview uses all originals despite the merge viewing its last item');
        const after = await saved(app);
        for (const id of ['source-a', 'source-b', 'source-c']) assert.deepEqual(sourceKeys(after, id), sourceKeys(before, id));
        assert.equal(after.nodes.find(node => node.id === 'merge').inputCount, 11);
        await reloadAppBrowser(app);
        await expectKeys(app, original);
        await app.waitFor("document.querySelector('#merge-merge-preview .image-save-preview-counter')?.textContent==='9/9'");
        await expectConnections(app, before.connections);
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('merge');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()"), geometry);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'merge').customTitle, '保留完整批次');
        assert.equal(await app.evaluate('mergeRequests.length'), 0);
    });
});

test('the universal merge input appends numbered slots, rejects duplicates, and supports replacement and stale retained output', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        ...['first', 'second', 'replacement'].map((id, index) => ({ id, type: 'ImageImport', x: 25, y: 140 + index * 230 })),
        { id: 'merge', type: 'ImageMerge', x: 550, y: 180, width: 350, height: 360, userResized: true }
    ], connections: [] }, async app => {
        await app.waitFor("Boolean(document.querySelector('#merge .universal-input'))");
        await upload(app, 'first', 'red'); await upload(app, 'second', 'blue'); await upload(app, 'replacement', 'orange');
        await connect(app, 'first');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===1)");
        const first = (await saved(app)).connections[0];
        assert.equal(first.to.port, 'image_1');
        await connect(app, 'second');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===2)");
        const full = await saved(app), records = full.connections, expected = [...sourceKeys(full, 'first'), ...sourceKeys(full, 'second')];
        assert.deepEqual(records.map(connection => connection.to.port), ['image_1', 'image_2']);
        await expectKeys(app, expected);
        await connect(app, 'first');
        await app.waitFor("document.getElementById('toast-container').innerText.match(/重复|已连接/)");
        await expectConnections(app, records); await expectKeys(app, expected);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'merge').inputCount, full.nodes.find(node => node.id === 'merge').inputCount, 'rejecting a duplicate does not partially append a dynamic port');
        await openInputs(app);
        const row = `#image-parameter-panel [data-input-connection-id="${first.id}"]`;
        await app.evaluate(`(()=>{document.querySelector('${row} [data-input-action=replace]').click();const source=document.querySelector('${row} [data-input-replacement-source]');source.value=JSON.stringify({nodeId:'replacement',port:'image'});source.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=cancel-replace]').click()})()`);
        await expectConnections(app, records); await expectKeys(app, expected);
        await app.evaluate(`(()=>{document.querySelector('${row} [data-input-action=replace]').click();const source=document.querySelector('${row} [data-input-replacement-source]');source.value=JSON.stringify({nodeId:'replacement',port:'image'});source.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=confirm-replace]').click()})()`);
        const replaced = [{ ...first, from: { nodeId: 'replacement', port: 'image' } }, records[1]], replacement = [...sourceKeys(full, 'replacement'), ...sourceKeys(full, 'second')];
        await expectConnections(app, replaced); await expectKeys(app, replacement);
        await history(app, 'z', '已撤回'); await expectConnections(app, records); await expectKeys(app, expected);
        await history(app, 'y', '已重做'); await expectConnections(app, replaced); await expectKeys(app, replacement);
        await openInputs(app);
        await app.evaluate(`document.querySelector('[data-input-connection-id="${records[1].id}"] [data-input-action=disconnect]').click()`);
        await expectConnections(app, [replaced[0]]); await expectKeys(app, sourceKeys(full, 'replacement'));
        await app.evaluate(`document.querySelector('[data-input-connection-id="${first.id}"] [data-input-action=disconnect]').click()`);
        await expectConnections(app, []);
        await app.waitFor("document.getElementById('merge-merge-preview').dataset.mergeState==='stale' && document.getElementById('merge').innerText.includes('未更新')");
        await expectKeys(app, sourceKeys(full, 'replacement'));
        assert.ok(await app.evaluate("document.querySelector('#merge-merge-preview img')?.naturalWidth>0"), 'disconnecting all sources retains the readable previous original');
        await history(app, 'z', '已撤回'); await expectConnections(app, [replaced[0]]);
        await history(app, 'y', '已重做'); await expectConnections(app, []);
        const after = await saved(app);
        assert.ok(after.nodes.find(node => node.id === 'merge').inputCount >= 2);
        for (const id of ['first', 'second', 'replacement']) assert.deepEqual(sourceKeys(after, id), sourceKeys(full, id));
    });
});

test('merge clone, paste and preserving deletion keep sparse source slots and shared originals intact', { timeout: 60000 }, async () => {
    const connections = [
        edge('sparse-b', 'b', 'image_10', { extension: { keep: 'B' } }),
        edge('sparse-a', 'a', 'image_2', { extension: { keep: 'A' } }),
        { id: 'merge-target', from: { nodeId: 'merge', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 1 },
        { id: 'other-target', from: { nodeId: 'other', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0 }
    ];
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'a', type: 'ImageImport', x: 20, y: 120, customTitle: 'Source A' },
        { id: 'b', type: 'ImageImport', x: 20, y: 420, customTitle: 'Source B' },
        { id: 'other', type: 'ImageImport', x: 20, y: 720, customTitle: 'Other source' },
        { id: 'merge', type: 'ImageMerge', x: 450, y: 180, inputCount: 11, imagePreviewIndex: 1, width: 350, height: 360, userResized: true, customTitle: 'Copied merge' },
        { id: 'target', type: 'ImageGenerate', x: 1000, y: 180, apiConfigId: 'image', providerId: 'p', prompt: 'must not execute' }
    ], connections }, async app => {
        await controlled(app);
        await upload(app, 'a', 'red'); await upload(app, 'b', 'blue'); await upload(app, 'other', 'orange');
        const firstGraph = await saved(app), keys = [...sourceKeys(firstGraph, 'a'), ...sourceKeys(firstGraph, 'b')];
        await expectKeys(app, keys);
        await browse(app, 1, 2);
        const original = await saved(app);
        await action(app, 'merge', 'context-menu-clone-node');
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=true;document.getElementById('btn-confirm-clone-node-count').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===6)");
        const cloned = await saved(app), clone = cloned.nodes.find(node => node.cloneSourceId === 'merge');
        assert.ok(clone?.isClone);
        assert.deepEqual(cloned.connections.filter(connection => connection.to.nodeId === clone.id).map(connection => connection.to.port).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))), ['image_2', 'image_10']);
        await action(app, clone.id, 'context-menu-run-to-here');
        await expectKeys(app, keys, clone.id);
        await app.waitFor(`document.getElementById('${clone.id}').classList.contains('completed') && document.getElementById('btn-stop').disabled`);
        await history(app, 'z', '已撤回');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===5)");
        await expectConnections(app, connections);
        await shortcut(app, 'a'); await shortcut(app, 'c');
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:850,clientY:500}));document.getElementById('context-menu-paste-nodes').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===10)");
        const pasted = await saved(app), copies = pasted.nodes.filter(node => !original.nodes.some(old => old.id === node.id)), copiedMerge = copies.find(node => node.type === 'ImageMerge');
        await expectKeys(app, keys, copiedMerge.id);
        assert.equal(copiedMerge.inputCount, 11);
        assert.equal(copiedMerge.imagePreviewIndex, 1);
        assert.deepEqual(pasted.connections.filter(connection => connection.to.nodeId === copiedMerge.id).map(connection => connection.to.port).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))), ['image_2', 'image_10']);
        const dx = copiedMerge.x - original.nodes.find(node => node.id === 'merge').x, dy = copiedMerge.y - original.nodes.find(node => node.id === 'merge').y;
        for (const title of ['Source A', 'Source B', 'Other source']) {
            const copy = copies.find(node => node.customTitle === title), old = original.nodes.find(node => node.customTitle === title);
            assert.deepEqual(copy.mediaAssetKeys, old.mediaAssetKeys);
            assert.deepEqual([copy.x - old.x, copy.y - old.y], [dx, dy], 'pasting preserves the relative source positions');
        }
        await history(app, 'z', '已撤回');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===5)");
        await expectConnections(app, connections);
        await app.evaluate("document.querySelector('#merge .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===4)");
        const removed = await saved(app), inputs = removed.connections.filter(connection => connection.to.nodeId === 'target').sort((a, b) => a.order - b.order);
        assert.deepEqual(inputs.map(connection => connection.from.nodeId), ['other', 'a', 'b'], 'preserving deletion expands sparse merge sources in numeric port order at the old output slot');
        assert.deepEqual(removed.connections.find(connection => connection.id === 'other-target'), connections[3]);
        await history(app, 'z', '已撤回'); await expectConnections(app, connections);
        await history(app, 'y', '已重做'); await expectConnections(app, removed.connections);
        assert.equal(await app.evaluate('mergeRequests.length'), 0, 'clone, paste, preserving deletion and history do not start provider requests');
        assert.ok(await app.evaluate(`Promise.all(${JSON.stringify(keys)}.map(key=>fetch('/api/storage/assets/'+encodeURIComponent(key)).then(response=>response.ok))).then(values=>values.every(Boolean))`), 'shared originals remain readable after the merge is removed');
    });
});

test('background merge output and owners remain attached to A while the same-ID merge in B keeps its own state', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app);
        const graphs = [
            { name: 'Merge A', workflowId: 'merge-background-a', nodes: [
                { id: 'a-source', type: 'ImageImport', x: 20, y: 120 },
                { id: 'source-b', type: 'ImageGenerate', x: 20, y: 420, apiConfigId: 'image', providerId: 'p', prompt: 'source-b' },
                { id: 'merge', type: 'ImageMerge', x: 500, y: 150, inputCount: 11, imagePreviewIndex: 1, width: 350, height: 360, userResized: true }
            ], connections: [edge('background-a', 'a-source', 'image_2'), edge('background-b', 'source-b', 'image_10')] },
            { name: 'Merge B', workflowId: 'merge-background-b', nodes: [
                { id: 'merge', type: 'ImageMerge', x: 500, y: 150, inputCount: 4, imagePreviewIndex: 0, width: 350, height: 360, userResized: true }
            ], connections: [] }
        ];
        for (const { name, ...graph } of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Merge A');
        await upload(app, 'a-source', 'red');
        await run(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='merge')?.mediaAssetKeys?.length===2)");
        await browse(app, 1, 2);
        await openInputs(app); await closeInputs(app);
        await app.evaluate("mergeHoldRequests=true;document.getElementById('btn-run').click()");
        await app.waitFor('mergePending===true');
        await openInputs(app);
        assert.equal(await app.evaluate("document.querySelector('[data-input-connection-id=background-a] [data-input-action=move-down]').disabled"), true, 'a running workflow cannot reorder waiting merge inputs');
        await activate(app, 'Merge B');
        assert.equal(await app.evaluate("document.querySelector('.workflow-item[data-name=\"Merge A\"]').classList.contains('is-running')"), true);
        await app.evaluate('releaseMergeImage()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Merge A\"]').classList.contains('is-running')");
        const untouched = await saved(app), other = untouched.nodes.find(node => node.id === 'merge');
        assert.equal(untouched.activeWorkflowId, 'merge-background-b');
        assert.deepEqual(untouched.connections, []);
        assert.equal(other.inputCount, 4);
        assert.equal(other.imagePreviewIndex || 0, 0);
        assert.ok(!other.mediaAssetKeys?.length, 'background A output cannot be assigned to visible B');
        await activate(app, 'Merge A');
        const completed = await saved(app), keys = [...sourceKeys(completed, 'a-source'), ...sourceKeys(completed, 'source-b')];
        await expectKeys(app, keys);
        await expectConnections(app, graphs[0].connections);
        assert.equal(completed.nodes.find(node => node.id === 'merge').inputCount, 11);
        assert.equal(completed.nodes.find(node => node.id === 'merge').imagePreviewIndex, 1);
        await app.waitFor("document.querySelector('#merge-merge-preview .image-save-preview-counter')?.textContent==='2/2'");
        assert.equal(await app.evaluate('mergeRequests.length'), 2, 'returning to A does not add a request beyond its initial and explicit background runs');
        await waitForAutosave(app);
        const owners = await app.evaluate("Promise.all(['merge-background-a','merge-background-b'].map(id=>fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(id)).then(response=>response.json()).then(result=>result.owners.filter(owner=>owner.ownerType==='workflow-node'&&owner.ownerId==='merge'))))");
        assert.deepEqual(owners[0][0]?.assetKeys, keys);
        assert.ok(owners[1].every(owner => !owner.assetKeys.length));
        await reloadAppBrowser(app);
        await expectKeys(app, keys);
        await app.waitFor("document.querySelector('#merge-merge-preview .image-save-preview-counter')?.textContent==='2/2'");
        await activate(app, 'Merge B');
        assert.equal((await saved(app)).nodes.find(node => node.id === 'merge').inputCount, 4);
        assert.ok(!(await saved(app)).nodes.find(node => node.id === 'merge').mediaAssetKeys?.length);
    });
});
