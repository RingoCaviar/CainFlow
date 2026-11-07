import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'words', type: 'Text', x: 0, y: 0, customTitle: '主提示词来源', text: 'connected prompt' },
        { id: 'camera', type: 'CameraControl', x: 0, y: 450, customTitle: '视角来源' },
        { id: 'parameters', type: 'CustomParams', x: 0, y: 850, customTitle: '参数来源', params: [{ key: 'seed', value: '42' }] },
        { id: 'references', type: 'ImageGenerate', x: 1100, y: 0, customTitle: '停用参考批次', enabled: false, apiConfigId: 'image', providerId: 'p', prompt: 'references', generationCount: 2 },
        { id: 'mask', type: 'ImageGenerate', x: 1100, y: 450, customTitle: '旧遮罩批次', apiConfigId: 'image', providerId: 'p', prompt: 'mask', generationCount: 2 },
        { id: 'missing', type: 'ImageImport', x: 1100, y: 850, customTitle: '缺失原图' },
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
    await app.evaluate("document.querySelector('#target .image-first-placeholder').click()");
    await app.waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='target' && !document.getElementById('image-parameter-panel').hidden");
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await app.waitFor("document.querySelector('#image-parameter-panel .image-parameter-references')?.checkVisibility()===true");
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
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

test('generation has one visible input and compact reference controls preserve all legacy roles and connection orders', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor("!!document.querySelector('#target .universal-input')");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>({port:port.dataset.port,type:port.dataset.type,label:port.querySelector('.port-label')?.textContent}))"),
            [{ port: 'auto', type: 'any', label: '输入' }], await app.evaluate("document.querySelector('#target .node-ports-row').outerHTML"));
        assert.equal(await app.evaluate("document.querySelectorAll('#target .node-port[data-direction=input]:not([data-port=auto])').length"), 5,
            'canonical inputs stay available for existing logical endpoint adapters');
        assert.ok(await app.evaluate("[...document.querySelectorAll('.image-first-card .node-port')].filter(p=>p.getClientRects().length).every(p=>getComputedStyle(p.querySelector('.port-label')).display==='none'&&p.title&&p.getAttribute('aria-label')&&p.querySelector('.port-dot').getClientRects().length)"), 'image ports keep their dots and accessible hover names without visible labels');
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#words .port-label')).display"), 'none', 'text ports hide labels under the shared node style');
        assert.equal(await app.evaluate("(()=>{const p=document.querySelector('#target .universal-input');p.removeAttribute('title');p.dispatchEvent(new Event('pointerenter'));return p.title===p.getAttribute('aria-label')})()"), true, 'hover restores its normal hint after an execution-error hint was cleared');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#untouched .node-port[data-direction=input]')].filter(port=>port.dataset.port!=='auto').map(port=>port.dataset.port)"), ['imageA', 'imageB'],
            'the migrated comparison card retains both canonical logical inputs');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#untouched .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto'],
            'the complete image family now shares the same visible universal input');

        await generateSources(app, [['references', 2, true], ['mask', 2]]);

        await openInputs(app);
        assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel [data-input-connection-id]').length"), 0, 'the retired input list is not recreated');
        const references = await app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-reference-connection]')].map(row=>({id:row.dataset.referenceConnection,text:row.textContent}))");
        assert.deepEqual(references.map(row=>row.id), ['reference-batch', 'missing-reference']);
        assert.match(references.find(row=>row.id==='missing-reference').text, /待输出/, 'a connected source without an imported original remains visible while awaiting its output');
        assert.match(await app.evaluate("document.getElementById('target-prompt-source').textContent"), /主提示词来源/);

        // A layout-only save must retain every canonical role and connection order.
        await app.evaluate("const field=document.getElementById('target-generation-count');field.value='2';field.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='target')?.generationCount===2)");
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.map(({id,from,to,type,order})=>({id,from,to,type,...(order===undefined?{}:{order})})))");
        assert.deepEqual(saved, session.connections);
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        await openInputs(app);
        const restored = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.map(({id,from,to,type,order})=>({id,from,to,type,...(order===undefined?{}:{order})})))");
        assert.deepEqual(restored, session.connections, 'all legacy canonical roles and connection orders survive reopening without the retired list');
    });
});
