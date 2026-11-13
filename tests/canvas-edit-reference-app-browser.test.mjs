import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'a', type: 'ImageImport', x: 40, y: 260, customTitle: '甲' },
        { id: 'b', type: 'ImageImport', x: 40, y: 700, customTitle: '乙' },
        { id: 'target', type: 'ImageGenerate', x: 540, y: 260, customTitle: '目标' }
    ],
    connections: [
        { id: 'edge-a', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 1 },
        { id: 'edge-b', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0 }
    ]
};
const referencePixels = await Promise.all(['red','orange','yellow','blue','green'].map(async color => (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));

test('mixed selection reuses internal paths and stays aligned across resize release undo and blur', {timeout:45000}, async()=>{
    await withAppBrowser(session,async app=>{
        await select(app,['a','target']);
        await app.evaluate(`window.dragFrames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));dragFrames()`);
        await app.evaluate(`window.internalPath=document.querySelector('path[data-conn-id="edge-a"]');window.externalPath=document.querySelector('path[data-conn-id="edge-b"]');window.initialPath=internalPath.getAttribute('d');window.initialExternal=externalPath.getAttribute('d');
            window.beginMixedDrag=()=>{const el=document.querySelector('#a .node-header'),r=el.getBoundingClientRect();window.dragPoint={x:r.x+25,y:r.y+12};el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:dragPoint.x,clientY:dragPoint.y}));};
            window.moveMixedDrag=dx=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:dragPoint.x+dx,clientY:dragPoint.y+10}));
            window.endMixedDrag=()=>document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:dragPoint.x+60,clientY:dragPoint.y+10}));
            window.edgesAligned=()=>['a','b'].every(id=>{const path=document.querySelector('path[data-conn-id="edge-'+id+'"]'),matrix=path.getScreenCTM();
                const source=document.querySelector('#'+id+' .node-port[data-direction="output"] .port-dot').getBoundingClientRect();
                const target=(document.querySelector('#target .universal-input .port-dot') || document.querySelector('#target .node-port[data-port="referenceImages"] .port-dot')).getBoundingClientRect();
                const a=path.getPointAtLength(0).matrixTransform(matrix),b=path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
                return Math.hypot(a.x-source.x-source.width/2,a.y-source.y-source.height/2)<2 && Math.hypot(b.x-target.x-target.width/2,b.y-target.y-target.height/2)<2;});
            beginMixedDrag();moveMixedDrag(30);dragFrames();`);
        await app.waitFor("internalPath.getAttribute('transform')?.startsWith('translate(')");
        assert.equal(await app.evaluate("internalPath.getAttribute('d')===initialPath"),true);
        assert.equal(await app.evaluate("externalPath.getAttribute('d')!==initialExternal"),true);
        assert.equal(await app.evaluate('edgesAligned()'),true);
        await app.evaluate("document.getElementById('a').style.width='480px';dragFrames()");
        await app.waitFor("internalPath.getAttribute('d')!==initialPath && edgesAligned()");
        await app.evaluate("window.resizedPath=internalPath.getAttribute('d');moveMixedDrag(60);dragFrames()");
        await app.waitFor("internalPath.getAttribute('transform')?.startsWith('translate(') && edgesAligned()");
        assert.equal(await app.evaluate("internalPath.getAttribute('d')===resizedPath"),true);
        await app.evaluate('endMixedDrag();dragFrames()');
        await app.waitFor("edgesAligned()");
        await undo(app);await app.waitFor('edgesAligned()');
        await app.evaluate('beginMixedDrag();moveMixedDrag(30);dragFrames()');
        await app.waitFor("internalPath.getAttribute('transform')?.startsWith('translate(')");
        await app.evaluate("window.dispatchEvent(new Event('blur'));dragFrames()");
        await app.waitFor("edgesAligned()");
    });
});

test('a quick cut crosses both wires along its route and one undo restores them', { timeout: 30000 }, async () => {
    const nodes = [
        { id: 'first-source', type: 'Text', x: 100, y: 120, text: 'first' },
        { id: 'first-target', type: 'Text', x: 620, y: 120 },
        { id: 'second-source', type: 'Text', x: 100, y: 405, text: 'second' },
        { id: 'second-target', type: 'Text', x: 620, y: 405 }
    ];
    const connections = ['first', 'second'].map(id => ({
        id: id + '-cut',
        from: { nodeId: id + '-source', port: 'text' },
        to: { nodeId: id + '-target', port: 'text' },
        type: 'text'
    }));
    const bothDrawn = `['first-cut', 'second-cut'].every(id =>
        Boolean(document.querySelector('path[data-conn-id="' + id + '"]')?.getAttribute('d')))`;
    await withAppBrowser({ ...session, nodes, connections }, async app => {
        await app.waitFor(bothDrawn);
        const points = await app.evaluate(`['first-cut', 'second-cut'].map(id => {
            const path = document.querySelector('path[data-conn-id="' + id + '"]');
            const { x, y } = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
            return { x, y };
        })`);
        const [first, second] = points;
        await app.evaluate(`(() => {
            const canvas = document.getElementById('canvas-container');
            const fire = (type, x, y, buttons) => canvas.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, ctrlKey: true, button: 2, buttons, clientX: x, clientY: y
            }));
            fire('mousedown', ${first.x}, ${first.y - 22}, 2);
            fire('mousemove', ${first.x}, ${first.y + 22}, 2);
            fire('mouseup', ${second.x}, ${second.y + 22}, 0);
        })()`);
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id$=-cut]').length"), 0);
        await undo(app);
        await app.waitFor(bothDrawn);
    });
});

test('an isolated node can insert into a wire at the final drag position and undo as one action', { timeout: 30000 }, async () => {
    const edge = {
        id: 'original-wire', from: { nodeId: 'input', port: 'image' },
        to: { nodeId: 'output', port: 'image' }, type: 'image'
    };
    await withAppBrowser({
        ...session,
        nodes: [
            { id: 'input', type: 'ImageImport', x: 80, y: 450 },
            { id: 'bridge', type: 'ImageResize', x: 430, y: 90 },
            { id: 'output', type: 'ImagePreview', x: 800, y: 450 }
        ],
        connections: [edge]
    }, async app => {
        const originalDrawn = "Boolean(document.querySelector('path[data-conn-id=original-wire]')?.getAttribute('d'))";
        await app.waitFor(originalDrawn);
        await app.evaluate(`(() => {
            const header = document.querySelector('#bridge .node-header');
            const node = document.getElementById('bridge').getBoundingClientRect();
            const rect = header.getBoundingClientRect();
            const start = { clientX: rect.x + 35, clientY: rect.y + rect.height / 2 };
            const path = document.querySelector('path[data-conn-id=original-wire]');
            const cross = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
            const fire = (target, type, point, buttons) => target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, buttons, ...point
            }));
            fire(header, 'mousedown', start, 1);
            fire(document, 'mousemove', { clientX: start.clientX + 12, clientY: start.clientY + 8 }, 1);
            fire(document, 'mouseup', {
                clientX: start.clientX + cross.x - node.x - node.width / 2,
                clientY: start.clientY + cross.y - node.y - node.height / 2
            }, 0);
        })()`);
        const inserted = await saved(app, "s=>s.connections.some(c=>c.from.nodeId==='input'&&c.to.nodeId==='bridge')&&s.connections.some(c=>c.from.nodeId==='bridge'&&c.to.nodeId==='output')");
        assert.equal(inserted.connections.length, 2);
        await undo(app);
        await app.waitFor(originalDrawn);
        assert.equal(await app.evaluate("parseFloat(document.getElementById('bridge').style.top)"), 90);
    });
});

async function action(app, id, menuId) {
    await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById('${menuId}').click()`);
}

async function referenceOrder(app, id) {
    return app.evaluate(`[...document.querySelectorAll('#${id}-reference-sources .image-reference-group')].map(el=>el.getAttribute('aria-label').split(' · ')[0])`);
}

async function key(app, key, { shiftKey = false } = {}) {
    await app.evaluate(`(()=>{const canvas=document.getElementById('canvas-container');canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',ctrlKey:true,shiftKey:${shiftKey},bubbles:true,cancelable:true}))})()`);
}

async function paste(app) {
    await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:800,clientY:450}));document.getElementById('context-menu-paste-nodes').click()");
}

async function saved(app, predicate) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>(${predicate})(s.value)).catch(()=>false)`);
    return app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value)");
}

async function history(app, actionKey, feedback) {
    await app.evaluate(`(()=>{
        window.historyFeedbackSeen=false;
        window.historyFeedbackObserver?.disconnect();
        window.historyFeedbackObserver=new MutationObserver(records=>{
            const toasts=records.flatMap(record=>[record.target.closest?.('.toast'),...Array.from(record.addedNodes).flatMap(node=>node.matches?.('.toast')?[node]:Array.from(node.querySelectorAll?.('.toast')||[]))]);
            if(toasts.some(node=>node?.textContent.includes('${feedback}'))){window.historyFeedbackSeen=true;window.historyFeedbackObserver.disconnect()}
        });
        window.historyFeedbackObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
    })()`);
    await key(app, actionKey);
    await app.waitFor('window.historyFeedbackSeen===true');
}

async function undo(app) { await history(app,'z','已撤回'); }
async function redo(app) { await history(app,'y','已重做'); }

test('repeated node moves never synchronously protect media and preserve originals through move, deletion, cleanup and undo redo', {timeout:45000}, async()=>{
    await withAppBrowser({...session,nodes:[{id:'source',type:'ImageImport',x:60,y:260}],connections:[]},async app=>{
        await app.evaluate(`(async()=>{const files=new DataTransfer();files.items.add(new File([await(await fetch('data:image/png;base64,${referencePixels[0]}')).blob()],'original.png',{type:'image/png'}));const input=document.getElementById('source-file');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        const original=(await saved(app,'s=>s.nodes[0]?.mediaAssetKeys?.length===1')).nodes[0].mediaAssetKeys[0];
        await app.evaluate(`(()=>{window.moveSyncRequests=0;const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,async){if(async===false)moveSyncRequests++;return open.apply(this,arguments)};window.retainedMoveNode=document.getElementById('source')})()`);
        for(let index=0;index<6;index++) {
            await app.evaluate(`(async()=>{const node=document.getElementById('source'),header=node.querySelector('.node-header'),r=header.getBoundingClientRect();window.beforeMove=[parseFloat(node.style.left),parseFloat(node.style.top)];header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.x+30,clientY:r.y+12}));const end={clientX:r.x+60,clientY:r.y+32};document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,...end}));await new Promise(requestAnimationFrame);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,...end}));window.afterMove=[parseFloat(node.style.left),parseFloat(node.style.top)]})()`);
        }
        assert.notDeepEqual(await app.evaluate('afterMove'),await app.evaluate('beforeMove'));
        assert.equal(await app.evaluate('moveSyncRequests'),0);
        await undo(app);
        assert.deepEqual(await app.evaluate("[parseFloat(document.getElementById('source').style.left),parseFloat(document.getElementById('source').style.top)]"),await app.evaluate('beforeMove'));
        await redo(app);
        assert.deepEqual(await app.evaluate("[parseFloat(document.getElementById('source').style.left),parseFloat(document.getElementById('source').style.top)]"),await app.evaluate('afterMove'));
        assert.equal(await app.evaluate("document.getElementById('source')===retainedMoveNode && moveSyncRequests===0"),true);
        await app.evaluate(`(async()=>{const header=document.querySelector('#source .node-header'),r=header.getBoundingClientRect();header.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,ctrlKey:true,clientX:r.x+30,clientY:r.y+12}));const end={clientX:r.x+90,clientY:r.y+52};document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,ctrlKey:true,...end}));await new Promise(requestAnimationFrame);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,...end}));})()`);
        await saved(app,'s=>s.nodes.length===2');
        assert.ok(await app.evaluate('moveSyncRequests>0'),'Ctrl-drag cloning still protects its full undo snapshot');
        await undo(app);await saved(app,'s=>s.nodes.length===1');
        await action(app,'source','context-menu-delete-nodes');
        await saved(app,'s=>s.nodes.length===0');
        assert.ok(await app.evaluate('moveSyncRequests>0'),'destructive edits still acknowledge media protection');
        await app.evaluate("fetch('/api/storage/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'clear-assets',mode:'all'})}).then(r=>{if(!r.ok)throw Error('cleanup failed');return r.json()})");
        assert.equal(await app.evaluate(`fetch('/api/storage/assets/'+encodeURIComponent('${original}')).then(r=>r.ok)`),true);
        await undo(app);
        assert.deepEqual((await saved(app,'s=>s.nodes.length===1')).nodes[0].mediaAssetKeys,[original]);
        await undo(app);
        assert.deepEqual(await app.evaluate("[parseFloat(document.getElementById('source').style.left),parseFloat(document.getElementById('source').style.top)]"),await app.evaluate('beforeMove'));
    });
});

async function reload(app, ready = 'window.__cainflowAppReady===true') {
    const previous = await app.evaluate('performance.timeOrigin');
    for (let attempt=0;attempt<2;attempt++) {
        await app.send('Page.reload',{ignoreCache:true});
        try {
            try { await app.waitFor(`performance.timeOrigin!==${previous}&&(${ready})`); }
            catch(error) {
                if(!String(error).includes('Inspected target navigated or closed')) throw error;
                await app.waitFor(`performance.timeOrigin!==${previous}&&(${ready})`);
            }
            return;
        }
        catch(error) { if(attempt || !String(error).includes('Failed to fetch dynamically imported module')) throw error; }
    }
}

async function select(app, ids) {
    await action(app, ids[0], 'context-menu-copy-nodes');
    for (const id of ids.slice(1)) {
        await app.evaluate(`(()=>{const header=document.querySelector('#${id} .node-header'),r=header.getBoundingClientRect(),event={bubbles:true,cancelable:true,button:0,ctrlKey:true,clientX:r.x+30,clientY:r.y+10};header.dispatchEvent(new MouseEvent('mousedown',event));window.dispatchEvent(new MouseEvent('mouseup',event))})()`);
    }
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node.selected')].map(n=>n.id).sort()"), [...ids].sort());
}

test('cloning with upstream connections retains every reference source in explicit order', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await action(app, 'target', 'context-menu-clone-node');
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=true;document.getElementById('btn-confirm-clone-node-count').click()");
        await app.waitFor("document.querySelectorAll('.node-clone').length===1");
        const id = await app.evaluate("document.querySelector('.node-clone').id");
        assert.deepEqual(await referenceOrder(app, id), ['乙', '甲'], 'clone retains all upstream reference sources in input order');
        assert.deepEqual(await referenceOrder(app, 'target'), ['乙', '甲'], 'the original node is unchanged');
    });
});

test('context-menu paste preserves reference order and is undone as one complete action', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await action(app, 'target', 'context-menu-copy-nodes');
        await paste(app);
        await app.waitFor("document.querySelectorAll('#nodes-layer > .node').length===4");
        const id = await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node')].find(n=>!['a','b','target'].includes(n.id)).id");
        assert.deepEqual(await referenceOrder(app, id), ['乙', '甲']);
        await key(app, 'z');
        await app.waitFor(`!document.getElementById('${id}')`);
        assert.deepEqual(await referenceOrder(app, 'target'), ['乙', '甲']);
    });
});

test('deleting a bridge while preserving connections keeps its reference slot and other sources', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session,
        nodes: [...session.nodes, { id: 'bridge', type: 'ImageResize', x: 300, y: 260 }],
        connections: [
            { id: 'into-bridge', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'bridge', port: 'image' }, type: 'image' },
            { id: 'bridge-output', from: { nodeId: 'bridge', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0 },
            { ...session.connections[1], order: 1 }
        ]
    }, async app => {
        await app.evaluate("document.querySelector('#bridge .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        await app.waitFor("!document.getElementById('bridge')");
        assert.deepEqual(await referenceOrder(app, 'target'), ['甲', '乙'], 'the upstream reference replaces the removed bridge in the same position');
    });
});

test('pasting across workflows cannot attach external connections to unrelated nodes that reuse IDs', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await action(app, 'target', 'context-menu-copy-nodes');
        assert.equal(await app.evaluate(`fetch('/api/workflows/Other',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ workflowId: 'other-workflow', nodes: session.nodes, connections: session.connections })})}).then(r=>r.ok)`), true);
        await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
        await app.waitFor("Boolean(document.querySelector('.workflow-item[data-name=Other]'))");
        await app.evaluate("document.querySelector('.workflow-item[data-name=Other]').click()");
        await app.waitFor("document.querySelector('.workflow-item[data-name=Other]').classList.contains('is-active')");
        await app.evaluate("document.getElementById('btn-close-workflow').click()");
        await paste(app);
        await app.waitFor("document.querySelectorAll('#nodes-layer > .node').length===4");
        const id = await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node')].find(n=>!['a','b','target'].includes(n.id)).id");
        assert.deepEqual(await referenceOrder(app, id), [], 'same IDs in another workflow are not the copied external reference sources');
        assert.deepEqual(await referenceOrder(app, 'target'), ['乙', '甲']);
    });
});

for (const entry of ['context', 'shortcut', 'plain']) {
    test(`${entry} multi-node paste preserves internal and requested external reference order through undo redo`, { timeout: 30000 }, async () => {
        await withAppBrowser(session, async app => {
            await select(app, ['a', 'target']);
            await key(app, 'c');
            if (entry === 'context') await paste(app);
            else if (entry === 'shortcut') await key(app, 'v', { shiftKey: true });
            else await app.evaluate("const transfer=new DataTransfer();document.getElementById('canvas-container').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}))");
            const graph = await saved(app, 's=>s.nodes.length===5');
            const copied = graph.nodes.filter(node => !['a', 'b', 'target'].includes(node.id));
            const target = copied.find(node => node.type === 'ImageGenerate');
            const source = copied.find(node => node.type === 'ImageImport');
            const links = graph.connections.filter(link => link.to.nodeId === target.id).sort((a,b)=>a.order-b.order);
            assert.deepEqual(links.map(link=>link.from.nodeId), entry==='plain' ? [source.id] : ['b',source.id]);
            assert.deepEqual(graph.connections.filter(link=>link.to.nodeId==='target'), session.connections, 'the original reference edges remain byte-for-byte equal');
            await undo(app);
            assert.deepEqual((await saved(app, 's=>s.nodes.length===3')).connections, session.connections);
            await redo(app);
            assert.deepEqual((await saved(app, 's=>s.nodes.length===5')).connections, graph.connections, 'redo retains the exact new IDs and reference order');
        });
    });
}

test('deleting a reference source and undoing or redoing preserves other edges and exact reference order', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await action(app, 'a', 'context-menu-delete-nodes');
        assert.deepEqual(await referenceOrder(app, 'target'), ['乙']);
        assert.deepEqual((await saved(app, 's=>s.nodes.length===2')).connections, [session.connections[1]]);
        await undo(app);
        assert.deepEqual((await saved(app, 's=>s.nodes.length===3')).connections, session.connections);
        assert.deepEqual(await referenceOrder(app, 'target'), ['乙','甲']);
        await redo(app);
        assert.deepEqual((await saved(app, 's=>s.nodes.length===2')).connections, [session.connections[1]]);
    });
});

test('preserving deletion expands a merged reference in place and undo redo restores both graphs exactly', { timeout: 30000 }, async () => {
    const connections = [
        { id:'merge-b',from:{nodeId:'b',port:'image'},to:{nodeId:'merge',port:'image_2'},type:'image' },
        { id:'tail',from:{nodeId:'d',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:2 },
        { id:'merge-a',from:{nodeId:'a',port:'image'},to:{nodeId:'merge',port:'image_1'},type:'image' },
        { id:'head',from:{nodeId:'c',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:0 },
        { id:'merged',from:{nodeId:'merge',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:1 }
    ];
    await withAppBrowser({...session,nodes:[...session.nodes,{id:'c',type:'ImageImport',x:1400,y:260,customTitle:'丙'},{id:'d',type:'ImageImport',x:1400,y:660,customTitle:'丁'},{id:'merge',type:'ImageMerge',x:300,y:260}],connections},async app=>{
        await app.evaluate("document.querySelector('#merge .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        assert.deepEqual(await referenceOrder(app,'target'),['丙','甲','乙','丁']);
        const deleted=await saved(app,'s=>s.nodes.length===5');
        await undo(app);
        assert.deepEqual((await saved(app,'s=>s.nodes.length===6')).connections,connections);
        await redo(app);
        assert.deepEqual((await saved(app,'s=>s.nodes.length===5')).connections,deleted.connections);
        assert.deepEqual(await referenceOrder(app,'target'),['丙','甲','乙','丁']);
    });
});

async function generatedReferences(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.controlledRequests=[];const nativeFetch=fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy'&&options.body){const body=options.body instanceof FormData?Object.fromEntries(options.body):JSON.parse(options.body);controlledRequests.push(body);if(window.holdTarget&&body.prompt==='target')await new Promise(resolve=>window.releaseTarget=resolve);return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(referencePixels)}[(controlledRequests.length-1)%5]}]}),{headers:{'Content-Type':'application/json'}})}return nativeFetch(url,options)};` });
    await reload(app,"window.__cainflowAppReady===true&&Boolean(document.getElementById('target-prompt'))");
    for (const [id, count] of [['a',3],['b',2]]) {
        await action(app, id, 'context-menu-run-to-here');
        await app.waitFor(`document.querySelector('#${id}-image-results .image-node-result-count')?.textContent.endsWith('/ ${count}')`);
        await saved(app, `s=>s.nodes.find(n=>n.id==='${id}')?.mediaAssetKeys?.length===${count}`);
    }
}

const generatedSession = { ...session, nodes: session.nodes.map(node => ({...node,type:'ImageGenerate',apiConfigId:'image',providerId:'p',prompt:node.id,generationCount:node.id==='a'?3:node.id==='b'?2:1})) };

test('copying generated reference sources retains the complete original batches and their durable order', { timeout: 45000 }, async () => {
    await withAppBrowser(generatedSession, async app => {
        await generatedReferences(app);
        const original = await saved(app, 's=>s.nodes.find(n=>n.id==="b")?.mediaAssetKeys?.length===2');
        await key(app,'a');
        await key(app,'c');
        await paste(app);
        const graph=await saved(app,'s=>s.nodes.length===6');
        const copies=graph.nodes.filter(node=>!['a','b','target'].includes(node.id));
        for(const title of ['甲','乙']) {
            assert.deepEqual(copies.find(node=>node.customTitle===title).mediaAssetKeys,original.nodes.find(node=>node.customTitle===title).mediaAssetKeys,'copy retains every original asset position');
        }
        const target=copies.find(node=>node.customTitle==='目标');
        assert.deepEqual(await referenceOrder(app,target.id),['乙','甲']);
        await select(app,['a','b']);
        await action(app,'a','context-menu-delete-nodes');
        await saved(app,'s=>s.nodes.length===4');
        await undo(app);
        await saved(app,'s=>s.nodes.length===6');
        await redo(app);
        await saved(app,'s=>s.nodes.length===4');
        await action(app,target.id,'context-menu-run-to-here');
        await app.waitFor("controlledRequests.some(request=>request.prompt==='target')&&!document.getElementById('"+target.id+"-prompt').disabled");
        await saved(app,`s=>s.nodes.find(n=>n.id==='${target.id}')?.mediaAssetKeys?.length===1`);
        await reload(app,`window.__cainflowAppReady===true&&!!document.getElementById('${target.id}-prompt')`);
        assert.deepEqual(await referenceOrder(app,target.id),['乙','甲']);
        for(const node of copies.filter(node=>node.customTitle!=='目标')) {
            await app.waitFor(`document.querySelector('#${node.id}-image-results .image-node-result-count')?.textContent.endsWith('/ ${node.mediaAssetKeys.length}')`);
            assert.ok(await app.evaluate(`Promise.all(${JSON.stringify(node.mediaAssetKeys)}.map(key=>fetch('/api/storage/assets/'+encodeURIComponent(key)).then(r=>r.ok))).then(results=>results.every(Boolean))`),'shared originals survive deleting their old nodes, undo redo and reopening');
        }
    });
});

test('preserving deletion traverses multiple selected bridge nodes without losing existing reference slots', { timeout: 30000 }, async () => {
    const connections=[
        {id:'first',from:{nodeId:'a',port:'image'},to:{nodeId:'one',port:'image'},type:'image'},
        {id:'middle',from:{nodeId:'one',port:'image'},to:{nodeId:'two',port:'image'},type:'image'},
        {id:'last',from:{nodeId:'two',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:0},
        {...session.connections[1],order:1}
    ];
    await withAppBrowser({...session,nodes:[...session.nodes,{id:'one',type:'ImageResize',x:300,y:260},{id:'two',type:'ImageResize',x:300,y:600}],connections},async app=>{
        await select(app,['one','two']);
        await app.evaluate("document.querySelector('#one .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        assert.deepEqual(await referenceOrder(app,'target'),['甲','乙']);
        await undo(app);
        assert.deepEqual((await saved(app,'s=>s.nodes.length===5')).connections,connections);
        await redo(app);
        assert.deepEqual(await referenceOrder(app,'target'),['甲','乙']);
    });
});

test('preserving deletion rejects expansion beyond reference capacity without removing nodes or edges', {timeout:30000}, async()=>{
    const retainedCount = 15;
    const connections=[
        {id:'merge-a',from:{nodeId:'a',port:'image'},to:{nodeId:'merge',port:'image_1'},type:'image'},
        {id:'merge-b',from:{nodeId:'b',port:'image'},to:{nodeId:'merge',port:'image_2'},type:'image'},
        {id:'merge-out',from:{nodeId:'merge',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:0},
        {id:'old-batch',from:{nodeId:'old',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:1,extension:{keep:'original-batch'}}
    ];
    await withAppBrowser({...session,nodes:[],connections:[]},async app=>{
        const images = await app.evaluate(`(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 2;
            const ctx = canvas.getContext('2d');
            return Array.from({ length: ${retainedCount} }, (_, index) => {
                ctx.fillStyle = 'rgb(' + index * 16 + ', 100, 200)';
                ctx.fillRect(0, 0, 2, 2);
                return canvas.toDataURL();
            });
        })()`);
        const nodes=[
            {id:'a',type:'ImageImport',x:40,y:400},
            {id:'b',type:'ImageImport',x:40,y:740},
            {id:'old',type:'ImagePreview',x:40,y:80,images,imageCount:retainedCount},
            {id:'target',type:'ImageGenerate',x:600,y:80,apiConfigId:'image',providerId:'p',prompt:'must not execute'},
            {id:'merge',type:'ImageMerge',x:300,y:400,inputCount:2,enabled:false}
        ];
        // Legacy inline originals enter through workflow migration. Session
        // snapshots intentionally omit pixels and require durable asset keys.
        assert.equal(await app.evaluate(`fetch('/api/workflows/Capacity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({workflowId:'capacity-workflow',nodes,connections})})}).then(response=>response.ok)`),true);
        await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
        await app.waitFor("Boolean(document.querySelector('.workflow-item[data-name=Capacity]'))");
        await app.evaluate("document.querySelector('.workflow-item[data-name=Capacity]').click()");
        await app.waitFor("document.querySelector('.workflow-item[data-name=Capacity]').classList.contains('is-active')&&!!document.getElementById('merge')");
        await app.evaluate("document.getElementById('btn-close-workflow').click()");
        for (const [index,id] of ['a','b'].entries()) {
            await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch('data:image/png;base64,${referencePixels[index]}')).blob()],'source.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        }
        await app.waitFor(`document.querySelector('#old-preview img')?.naturalWidth>0&&document.querySelector('#old-preview .image-save-preview-counter')?.textContent.endsWith('/${retainedCount}')`);
        await app.evaluate("document.querySelector('#old-preview .image-save-preview-counter').click()");
        await app.waitFor(`document.querySelectorAll('#old-preview [data-preview-batch-index]').length===${retainedCount}`);
        await saved(app,"s=>['a','b'].every(id=>s.nodes.find(node=>node.id===id)?.mediaAssetKeys?.length===1)");
        await waitForAutosave(app);
        await app.waitFor(`fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json()).then(graph=>graph.nodes?.find(node=>node.id==='old')?.imageCount===${retainedCount}&&graph.nodes.find(node=>node.id==='merge')?.enabled===false)`);
        const before=await saved(app,`s=>s.nodes.length===5&&s.nodes.find(node=>node.id==='old')?.imageCount===${retainedCount}&&s.nodes.find(node=>node.id==='old')?.mediaAssetKeys?.length===${retainedCount}`);
        assert.deepEqual(before.connections,connections);
        // GPT Image accepts the 15 active originals. Bypassing the disabled
        // Merge would activate two more originals, exceeding the model limit of 16.
        await app.evaluate("document.querySelector('#merge .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('无法完整保留连线'))");
        assert.ok(await app.evaluate("!!document.getElementById('merge')"),'a full input cannot silently drop one source when bypassing a merge');
        const after=await saved(app,'s=>s.nodes.length===5');
        assert.deepEqual(after.nodes,before.nodes,'rejection preserves every node and its metadata');
        assert.deepEqual(after.connections,before.connections,'rejection preserves the complete ordered graph and edge metadata');
    });
});

test('copying an image during its local asset write retains the original when pasted later', {timeout:30000}, async()=>{
    await withAppBrowser({...session,nodes:[{id:'source',type:'ImageImport',x:60,y:260}],connections:[]},async app=>{
        await app.send('Page.addScriptToEvaluateOnNewDocument',{source:`const realFetch=window.fetch;let held=false;window.fetch=async(url,options={})=>{if(!held&&String(url)==='/api/storage/media-assets'&&options.method==='PUT'){held=true;window.assetHeld=true;await new Promise(resolve=>window.releaseAssetWrite=resolve)}return realFetch(url,options)}`});
        await reload(app);
        await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch('data:image/png;base64,${referencePixels[0]}')).blob()],'original.png',{type:'image/png'}));const input=document.getElementById('source-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await app.waitFor('window.assetHeld===true');
        await action(app,'source','context-menu-copy-nodes');
        await app.evaluate('window.releaseAssetWrite()');
        const original=await saved(app,'s=>s.nodes[0]?.mediaAssetKeys?.length===1');
        await paste(app);
        const graph=await saved(app,'s=>s.nodes.length===2');
        const copied=graph.nodes.find(node=>node.id!=='source');
        assert.ok(await app.evaluate(`Boolean(document.querySelector('#${copied.id} .file-drop-zone img'))`),'the pasted node displays the captured original');
        const settled=await saved(app,`s=>s.nodes.find(n=>n.id==='${copied.id}')?.mediaAssetKeys?.length===1`);
        assert.deepEqual(settled.nodes.find(n=>n.id===copied.id).mediaAssetKeys,original.nodes[0].mediaAssetKeys,'the pending copy keeps the actual original instead of an empty placeholder');
    });
});

test('clipboard originals survive deleting the source, undo eviction and ordinary cache cleanup', {timeout:30000}, async()=>{
    await withAppBrowser({...session,nodes:[{id:'source',type:'ImageImport',x:60,y:260}],connections:[]},async app=>{
        await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch('data:image/png;base64,${referencePixels[0]}')).blob()],'original.png',{type:'image/png'}));const input=document.getElementById('source-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        const graph=await saved(app,'s=>s.nodes[0]?.mediaAssetKeys?.length===1');
        const asset=graph.nodes[0].mediaAssetKeys[0];
        await action(app,'source','context-menu-copy-nodes');
        await action(app,'source','context-menu-delete-nodes');
        await app.waitFor("!document.getElementById('source')&&document.getElementById('context-menu').classList.contains('hidden')");
        for(let i=0;i<6;i++) await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:300}));document.querySelector('.context-menu-item[data-type=ImageGenerate]').click()");
        await saved(app,'s=>s.nodes.length===6');
        for(let i=0;i<3;i++) await app.evaluate("fetch('/api/storage/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'clear-assets',mode:'all'})}).then(r=>r.json())");
        assert.equal(await app.evaluate(`fetch('/api/storage/assets/'+encodeURIComponent('${asset}')).then(r=>r.ok)`),true,'the current clipboard retains its original independently of the undo stack');
        await paste(app);
        await saved(app,'s=>s.nodes.length===7');
        assert.ok(await app.evaluate("!!document.querySelector('.node-import .file-drop-zone img')"));
    });
});

test('an independent copy cannot inherit a pending image task belonging to the original node', {timeout:30000},async()=>{
    await withAppBrowser({...session,nodes:session.nodes.map(node=>node.id==='target'?{...node,imageTaskId:'original-remote-task',imageTaskStatus:'processing',imageTaskProgress:'50'}:node)},async app=>{
        await action(app,'target','context-menu-copy-nodes');
        await paste(app);
        const graph=await saved(app,'s=>s.nodes.length===4');
        const copy=graph.nodes.find(node=>!['a','b','target'].includes(node.id));
        assert.equal(copy.imageTaskId||'','','a copied node starts an independent generation lifecycle');
        assert.equal(graph.nodes.find(node=>node.id==='target').imageTaskId,'original-remote-task');
    });
});

test('an independent video copy cannot inherit a pending remote task belonging to the original node', {timeout:30000},async()=>{
    await withAppBrowser({...session,models:[...session.models,{id:'video',modelId:'veo-3',name:'受控视频',protocol:'veo-unified',taskType:'video',providerIds:['p']}],nodes:session.nodes.map(node=>node.id==='target'?{...node,type:'VideoGenerate',apiConfigId:'video',videoId:'original-video-task',videoStatus:'processing'}:node)},async app=>{
        await action(app,'target','context-menu-copy-nodes');
        await paste(app);
        const graph=await saved(app,'s=>s.nodes.length===4');
        const copy=graph.nodes.find(node=>!['a','b','target'].includes(node.id));
        assert.equal(copy.videoId||'','','the new video node must not resume or cancel the original remote task');
        assert.equal(graph.nodes.find(node=>node.id==='target').videoId,'original-video-task');
    });
});

for(const [type,sourceType,port] of [['ImageMerge','ImageImport','image'],['TextMerge','Text','text']]) for(const mode of ['paste','clone']) {
    test(`${type} ${mode} retains every numbered dynamic input instead of dropping later sources`,{timeout:30000},async()=>{
        const connections=['b','a'].map((id,index)=>({id:'in-'+id,from:{nodeId:id,port},to:{nodeId:'merge',port:`${port}_${id==='a'?1:2}`},type:port}));
        await withAppBrowser({...session,nodes:[{id:'a',type:sourceType,x:40,y:260},{id:'b',type:sourceType,x:40,y:600},{id:'merge',type,x:540,y:260}],connections},async app=>{
            if(mode==='paste') { await key(app,'a');await key(app,'c');await paste(app); }
            else {
                await action(app,'merge','context-menu-clone-node');
                await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=true;document.getElementById('btn-confirm-clone-node-count').click()");
            }
            const graph=await saved(app,`s=>s.nodes.length===${mode==='paste'?6:4}`);
            const merge=graph.nodes.find(node=>node.type===type&&node.id!=='merge');
            const links=graph.connections.filter(link=>link.to.nodeId===merge.id);
            assert.deepEqual(links.map(link=>link.to.port).sort(),[port+'_1',port+'_2'],'both restored dynamic inputs must be wired');
            assert.deepEqual(graph.connections.filter(link=>link.to.nodeId==='merge'),connections);
            await undo(app);
            assert.deepEqual((await saved(app,'s=>s.nodes.length===3')).connections,connections);
            await redo(app);
            assert.deepEqual((await saved(app,`s=>s.nodes.length===${mode==='paste'?6:4}`)).connections,graph.connections);
        });
    });
}

const nodeTypes=['ImageImport','ImageCompare','ImageMerge','ImageResize','ColorReset','ImageGenerate','VideoGenerate','CameraControl','CustomParams','TextChat','Text','TextMerge','TextSplit','ImagePreview','ImageSave'];
for(const type of nodeTypes) {
    test(`${type} ${type === 'ImageSave' ? 'rejects duplication and preserves legacy delete undo' : 'copy delete undo redo'} leaves an unrelated reference graph intact and preserves disabled state`,{timeout:30000},async()=>{
        await withAppBrowser({...session,models:[...session.models,{id:'video',modelId:'veo-3',name:'受控视频',protocol:'veo-unified',taskType:'video',providerIds:['p']}],nodes:[
            ...session.nodes.map(n=>({...n,x:1600+n.x})),
            {id:'sample',type,x:60,y:260,enabled:false,customTitle:'复制样本',apiConfigId:type==='VideoGenerate'?'video':type==='TextChat'?'chat':'image',providerId:'p',params:[{key:'payload',value:'saved value'}],text:'one\n\ntwo',outputCount:2}
        ]},async app=>{
            await action(app,'sample','context-menu-copy-nodes');
            await paste(app);
            if (type === 'ImageSave') {
                await waitForAutosave(app);
                assert.deepEqual((await saved(app,'s=>s.nodes.length===4')).connections,session.connections);
                assert.equal(await app.evaluate("document.querySelectorAll('.node-save').length"),1,'retired Save nodes cannot be duplicated');
                await action(app,'sample','context-menu-delete-nodes');
                await saved(app,'s=>s.nodes.length===3');
                await undo(app);
                const restored=await saved(app,'s=>s.nodes.length===4');
                assert.equal(restored.nodes.find(node=>node.id==='sample').enabled,false);
                assert.deepEqual(restored.connections,session.connections);
                return;
            }
            const graph=await saved(app,'s=>s.nodes.length===5');
            const copy=graph.nodes.find(n=>!['a','b','target','sample'].includes(n.id));
            assert.equal(copy.type,type);
            assert.equal(copy.enabled,false,'copy retains disabled inputs rather than silently enabling them');
            assert.equal(copy.customTitle,'复制样本');
            assert.deepEqual(graph.connections,session.connections);
            await undo(app);
            assert.deepEqual((await saved(app,'s=>s.nodes.length===4')).connections,session.connections);
            await redo(app);
            assert.deepEqual((await saved(app,'s=>s.nodes.length===5')).connections,session.connections);
            await action(app,copy.id,'context-menu-delete-nodes');
            assert.deepEqual((await saved(app,'s=>s.nodes.length===4')).connections,session.connections);
            await undo(app);
            assert.deepEqual((await saved(app,'s=>s.nodes.length===5')).connections,session.connections);
        });
    });
}

test('deleting an idle source cannot remove an input edge from a running downstream node', { timeout: 45000 }, async () => {
    await withAppBrowser(generatedSession, async app => {
        await generatedReferences(app);
        await app.evaluate('window.holdTarget=true');
        await action(app,'target','context-menu-run-to-here');
        await app.waitFor("controlledRequests.some(request=>request.prompt==='target')&&!!document.querySelector('#target.running')");
        await action(app,'a','context-menu-delete-nodes');
        assert.ok(await app.evaluate("Boolean(document.getElementById('a'))"),'a running target locks its connected source against deletion');
        assert.deepEqual(await referenceOrder(app,'target'),['乙','甲']);
        await app.evaluate('window.releaseTarget()');
    });
});
