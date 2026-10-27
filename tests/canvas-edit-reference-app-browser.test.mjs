import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
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

async function action(app, id, menuId) {
    await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById('${menuId}').click()`);
}

async function referenceOrder(app, id) {
    return app.evaluate(`[...document.querySelectorAll('#${id}-reference-sources .image-reference-locate')].map(el=>el.textContent.split(' · ')[0])`);
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
    const sources=Array.from({length:63},(_,i)=>({id:'old-'+i,type:'ImageImport',x:1800,y:i*400}));
    const connections=[
        {id:'merge-a',from:{nodeId:'a',port:'image'},to:{nodeId:'merge',port:'image_1'},type:'image'},
        {id:'merge-b',from:{nodeId:'b',port:'image'},to:{nodeId:'merge',port:'image_2'},type:'image'},
        {id:'merge-out',from:{nodeId:'merge',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:0},
        ...sources.map((n,i)=>({id:'old-edge-'+i,from:{nodeId:n.id,port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:i+1}))
    ];
    await withAppBrowser({...session,nodes:[...session.nodes,...sources,{id:'merge',type:'ImageMerge',x:300,y:260}],connections},async app=>{
        await app.evaluate("document.querySelector('#merge .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))");
        assert.ok(await app.evaluate("!!document.getElementById('merge')"),'a full input cannot silently drop one source when bypassing a merge');
        assert.deepEqual((await saved(app,'s=>s.nodes.length===67')).connections,connections);
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
    test(`${type} copy delete undo redo leaves an unrelated reference graph intact and preserves disabled state`,{timeout:30000},async()=>{
        await withAppBrowser({...session,models:[...session.models,{id:'video',modelId:'veo-3',name:'受控视频',protocol:'veo-unified',taskType:'video',providerIds:['p']}],nodes:[
            ...session.nodes.map(n=>({...n,x:1600+n.x})),
            {id:'sample',type,x:60,y:260,enabled:false,customTitle:'复制样本',apiConfigId:type==='VideoGenerate'?'video':type==='TextChat'?'chat':'image',providerId:'p',params:[{key:'payload',value:'saved value'}],text:'one\n\ntwo',outputCount:2}
        ]},async app=>{
            await action(app,'sample','context-menu-copy-nodes');
            await paste(app);
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
