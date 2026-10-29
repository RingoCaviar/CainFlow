import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'words', type: 'Text', x: 0, y: 0, customTitle: '主提示词来源', text: 'connected prompt' },
        { id: 'camera', type: 'CameraControl', x: 0, y: 450, customTitle: '视角来源' },
        { id: 'parameters', type: 'CustomParams', x: 0, y: 850, customTitle: '参数来源', params: [{ key: 'seed', value: '42' }] },
        { id: 'references', type: 'ImageGenerate', x: 1100, y: 0, customTitle: '停用参考批次', enabled: false, apiConfigId: 'image', providerId: 'p', prompt: 'references', generationCount: 2 },
        { id: 'mask', type: 'ImageGenerate', x: 1100, y: 450, customTitle: '旧遮罩批次', apiConfigId: 'image', providerId: 'p', prompt: 'mask', generationCount: 2 },
        { id: 'missing', type: 'ImageImport', x: 1100, y: 850, customTitle: '缺失原图', mediaAssetKeys: ['media:missing-reference'], imageCount: 1 },
        { id: 'target', type: 'ImageGenerate', x: 450, y: 40, width: 420, apiConfigId: 'image', providerId: 'p', prompt: 'local draft' },
        { id: 'untouched', type: 'ImageCompare', x: 1500, y: 0 }
    ],
    connections: [
        { id: 'main-text', from: { nodeId: 'words', port: 'text' }, to: { nodeId: 'target', port: 'prompt' }, type: 'text' },
        { id: 'camera-text', from: { nodeId: 'camera', port: 'text' }, to: { nodeId: 'target', port: 'camera_prompt' }, type: 'text' },
        { id: 'custom-parameters', from: { nodeId: 'parameters', port: 'params' }, to: { nodeId: 'target', port: 'params' }, type: 'params' },
        { id: 'reference-batch', from: { nodeId: 'references', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 2 },
        { id: 'legacy-mask', from: { nodeId: 'mask', port: 'image' }, to: { nodeId: 'target', port: 'mask' }, type: 'image' },
        { id: 'missing-reference', from: { nodeId: 'missing', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 5 }
    ]
};

async function openInputs(app) {
    await app.evaluate("document.querySelector('#target .image-first-placeholder button').click()");
    await app.waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='target' && !document.getElementById('image-parameter-panel').hidden");
    await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()");
    await app.waitFor("document.querySelector('#image-parameter-panel [data-parameter-group=input]')?.hidden===false");
}

async function generateSources(app, sources) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.inputGenerationRequests=0;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy'&&options.body){window.inputGenerationRequests++;return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(png.split(',')[1])}}]}),{headers:{'Content-Type':'application/json'}})};
        return nativeFetch(url,options);
    };` });
    await reloadAppBrowser(app);
    for (const [id, count, disabled = false] of sources) {
        if (disabled) await app.evaluate(`document.querySelector('#${id} .node-bypass-btn').click()`);
        await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='${id}')?.mediaAssetKeys?.length===${count})`);
        await app.waitFor(`!document.getElementById('${id}-prompt').disabled`);
        if (disabled) await app.evaluate(`document.querySelector('#${id} .node-bypass-btn').click()`);
    }
}

async function history(app, key, feedback) {
    await app.evaluate(`(()=>{window.inputHistoryFeedback=false;window.inputHistoryObserver?.disconnect();
        window.inputHistoryObserver=new MutationObserver(records=>{const toasts=records.flatMap(record=>[record.target.closest?.('.toast'),...Array.from(record.addedNodes).flatMap(node=>node.matches?.('.toast')?[node]:Array.from(node.querySelectorAll?.('.toast')||[]))]);
        if(toasts.some(node=>node?.textContent.includes(${JSON.stringify(feedback)}))){window.inputHistoryFeedback=true;window.inputHistoryObserver.disconnect()}});
        window.inputHistoryObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
        document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('window.inputHistoryFeedback===true');
}

test('generation has one visible input and its detail preserves real roles, batches and legacy connections', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor("!!document.querySelector('#target .universal-input')");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>({port:port.dataset.port,type:port.dataset.type,label:port.querySelector('.port-label')?.textContent}))"),
            [{ port: 'auto', type: 'any', label: '输入' }], await app.evaluate("document.querySelector('#target .node-ports-row').outerHTML"));
        assert.equal(await app.evaluate("document.querySelectorAll('#target .node-port[data-direction=input]:not([data-port=auto])').length"), 5,
            'canonical inputs stay available for existing logical endpoint adapters');
        assert.ok(await app.evaluate("[...document.querySelectorAll('.image-first-card .node-port')].filter(p=>p.getClientRects().length).every(p=>getComputedStyle(p.querySelector('.port-label')).display==='none'&&p.title&&p.getAttribute('aria-label')&&p.querySelector('.port-dot').getClientRects().length)"), 'image ports keep their dots and accessible hover names without visible labels');
        assert.notEqual(await app.evaluate("getComputedStyle(document.querySelector('#words .port-label')).display"), 'none', 'text ports retain their labels');
        assert.equal(await app.evaluate("(()=>{const p=document.querySelector('#target .universal-input');p.removeAttribute('title');p.dispatchEvent(new Event('pointerenter'));return p.title===p.getAttribute('aria-label')})()"), true, 'hover restores its normal hint after an execution-error hint was cleared');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#untouched .node-port[data-direction=input]')].filter(port=>port.dataset.port!=='auto').map(port=>port.dataset.port)"), ['imageA', 'imageB'],
            'the migrated comparison card retains both canonical logical inputs');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#untouched .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto'],
            'the complete image family now shares the same visible universal input');

        await generateSources(app, [['references', 2, true], ['mask', 2]]);

        await openInputs(app);
        const rows = await app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-input-connection-id]')].map(row=>({id:row.dataset.inputConnectionId,role:row.querySelector('[data-input-role]')?.value,text:row.textContent}))");
        assert.equal(rows.length, session.connections.length);
        for (const edge of session.connections) {
            const row = rows.find(item => item.id === edge.id);
            assert.ok(row, `input detail retains connection ${edge.id}`);
            assert.equal(row.role, edge.to.port);
        }
        assert.match(rows.find(row => row.id === 'reference-batch').text, /图片.*2\s*张.*停用/s);
        assert.match(rows.find(row => row.id === 'legacy-mask').text, /来源第\s*1\s*张/);
        assert.match(rows.find(row => row.id === 'missing-reference').text, /缺失/);
        assert.match(rows.find(row => row.id === 'main-text').text, /主提示词来源.*文本/s);
        assert.match(rows.find(row => row.id === 'camera-text').text, /视角来源.*文本/s);
        assert.match(rows.find(row => row.id === 'custom-parameters').text, /参数来源.*参数/s);

        // A layout-only save must retain every canonical role and connection order.
        await app.evaluate("const field=document.getElementById('target-generation-count');field.value='2';field.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='target')?.generationCount===2)");
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.map(({id,from,to,type,order})=>({id,from,to,type,...(order===undefined?{}:{order})})))");
        assert.deepEqual(saved, session.connections);
        await reloadAppBrowser(app);
        await openInputs(app);
        assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel [data-input-connection-id]').length"), session.connections.length);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-connection-id=legacy-mask] [data-input-role]').value"), 'mask');
    });
});

test('explicitly replacing a legacy mask with its same source upgrades consumption and undo restores its compatibility', { timeout: 45000 }, async () => {
    const edge = { id: 'same-source-mask', from: { nodeId: 'mask-source', port: 'image' },
        to: { nodeId: 'target', port: 'mask' }, type: 'image', maskConsumption: 'legacy-first' };
    await withAppBrowser({ ...session, nodes: [
        { id: 'mask-source', type: 'ImageGenerate', x: 20, y: 40, apiConfigId: 'image', providerId: 'p', prompt: 'mask-source', generationCount: 1 },
        session.nodes.find(node => node.id === 'target')
    ], connections: [edge] }, async app => {
        await generateSources(app, [['mask-source', 1]]);
        await openInputs(app);
        assert.equal(await app.evaluate('window.inputGenerationRequests'), 1);
        const row = '#image-parameter-panel [data-input-connection-id=same-source-mask]';
        assert.match(await app.evaluate(`document.querySelector('${row}').textContent`), /来源第\s*1\s*张/);
        await app.evaluate(`document.querySelector('${row} [data-input-action=replace]').click()`);
        await app.evaluate(`(()=>{const source=document.querySelector('${row} [data-input-replacement-source]');source.value=JSON.stringify({nodeId:'mask-source',port:'image'});source.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=confirm-replace]').click()})()`);
        async function consumption(expected) {
            await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='same-source-mask')?.maskConsumption===${JSON.stringify(expected)})`);
            const saved = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='same-source-mask'))");
            assert.deepEqual(saved, { ...edge, maskConsumption: expected }, 'changing consumption preserves the exact edge identity and endpoints');
        }
        await consumption('single');
        assert.doesNotMatch(await app.evaluate(`document.querySelector('${row}').textContent`), /旧连接兼容/);
        await history(app, 'z', '已撤回');
        await consumption('legacy-first');
        await history(app, 'y', '已重做');
        await consumption('single');
        assert.equal(await app.evaluate('window.inputGenerationRequests'), 1, 'undo and redo restore the graph without executing generation');
    });
});

test('input detail changes a specific role and replaces only its selected source with cancel and undo protection', { timeout: 45000 }, async () => {
    const edges = [
        { id: 'editable-reference', from: { nodeId: 'first-source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 4 },
        { id: 'protected-reference', from: { nodeId: 'other-source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 9 }
    ];
    await withAppBrowser({ ...session, nodes: [
        ...['first-source', 'other-source', 'replacement-source'].map((id, index) => ({ id, type: 'ImageGenerate', x: 20, y: 40 + index * 350,
            apiConfigId: 'image', providerId: 'p', prompt: id, generationCount: 1 })),
        session.nodes.find(node => node.id === 'target')
    ], connections: edges }, async app => {
        await generateSources(app, [['first-source', 1], ['other-source', 1], ['replacement-source', 1]]);
        await openInputs(app);
        const row = '#image-parameter-panel [data-input-connection-id=editable-reference]';
        async function records() {
            return app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections)");
        }
        async function waitForSource(source) {
            await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='editable-reference')?.from.nodeId===${JSON.stringify(source)})`);
        }
        const originalGraph = await records();
        assert.deepEqual(originalGraph.slice(0, edges.length), edges);
        await app.evaluate(`document.querySelector('${row} [data-input-action=replace]').click()`);
        await app.evaluate(`(()=>{const field=document.querySelector('${row} [data-input-replacement-source]');field.value=JSON.stringify({nodeId:'replacement-source',port:'image'});field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=cancel-replace]').click()})()`);
        assert.deepEqual(await records(), originalGraph, 'choosing a replacement and cancelling does not edit the graph');

        await app.evaluate(`(()=>{const field=document.querySelector('${row} [data-input-role]');field.value='mask';field.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='editable-reference')?.to.port==='mask')");
        const changedRole = await records();
        assert.equal(changedRole[0].id, edges[0].id);
        assert.equal(changedRole[0].order, edges[0].order);
        assert.equal(changedRole[0].maskConsumption, 'single');
        assert.deepEqual(changedRole.slice(1), originalGraph.slice(1));

        await history(app, 'z', '已撤回');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='editable-reference')?.to.port==='referenceImages')");
        await openInputs(app);
        await app.evaluate(`document.querySelector('${row} [data-input-action=replace]').click()`);
        await app.evaluate(`(()=>{const field=document.querySelector('${row} [data-input-replacement-source]');field.value=JSON.stringify({nodeId:'replacement-source',port:'image'});field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${row} [data-input-action=confirm-replace]').click()})()`);
        await waitForSource('replacement-source');
        const replaced = await records();
        assert.deepEqual(replaced[0], { ...edges[0], from: { nodeId: 'replacement-source', port: 'image' } });
        assert.deepEqual(replaced.slice(1), originalGraph.slice(1), 'other connections retain their exact identity, role and order');
        await history(app, 'z', '已撤回');
        await waitForSource('first-source');
        assert.deepEqual(await records(), originalGraph);
        await history(app, 'y', '已重做');
        await waitForSource('replacement-source');
        assert.deepEqual(await records(), replaced);
    });
});
