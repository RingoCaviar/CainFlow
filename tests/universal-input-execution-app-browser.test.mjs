import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const otherPng = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'mask-source', type: 'ImageGenerate', x: 40, y: 100, apiConfigId: 'image', providerId: 'p', prompt: 'mask source', generationCount: 1 },
        { id: 'mask-target', type: 'ImageGenerate', x: 550, y: 100, apiConfigId: 'image', providerId: 'p', prompt: 'masked target' }
    ],
    connections: [
        { id: 'reference', from: { nodeId: 'mask-source', port: 'image' }, to: { nodeId: 'mask-target', port: 'referenceImages' }, type: 'image', order: 0 },
        { id: 'single-mask', from: { nodeId: 'mask-source', port: 'image' }, to: { nodeId: 'mask-target', port: 'mask' }, type: 'image', maskConsumption: 'single' }
    ]
};

async function controlImages(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.imageRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy') {
            const form=options.body instanceof FormData,body=form?Object.fromEntries(options.body):JSON.parse(options.body);
            if(typeof body.prompt==='string') {
                const index=imageRequests.filter(r=>r.prompt===body.prompt).length;
                imageRequests.push({prompt:body.prompt,mask:body.mask instanceof Blob,maskData:body.mask instanceof Blob?btoa(String.fromCharCode(...new Uint8Array(await body.mask.arrayBuffer()))):'',references:form?(options.body.getAll('image[]').length||Number(options.body.has('image'))):0});
                return new Response(JSON.stringify({data:[{b64_json:body.prompt==='mask source'&&index%2===1?'${otherPng}':'${png}'}]}),{headers:{'Content-Type':'application/json'}});
            }
        } return nativeFetch(url,options);
    };` });
    await reloadAppBrowser(app);
}

test('a new single-image mask cannot silently consume a later multi-image batch, including after reopen', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, waitFor } = app;
        await waitFor("Boolean(document.getElementById('mask-source')) && Boolean(document.getElementById('mask-target'))");
        await controlImages(app);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("imageRequests.some(r=>r.prompt==='masked target') && document.getElementById('btn-stop').disabled");
        assert.equal(await evaluate("imageRequests.find(r=>r.prompt==='masked target').mask"), true);
        await evaluate("(()=>{const field=document.getElementById('mask-source-generation-count');field.value='2';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('btn-run').click()})()");
        await waitFor("imageRequests.filter(r=>r.prompt==='mask source').length===3 && document.getElementById('btn-stop').disabled");
        assert.equal(await evaluate("imageRequests.filter(r=>r.prompt==='masked target').length"), 1, 'changed mask batch is blocked before a new provider request');
        assert.match(await evaluate("document.querySelector('#mask-target .node-failure-summary').textContent"), /单图/);
        await waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.connections?.find(c=>c.id==='single-mask')?.maskConsumption==='single' && saved.nodes.find(n=>n.id==='mask-source')?.generationCount===2})()");
        await reloadAppBrowser(app);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("imageRequests.filter(r=>r.prompt==='mask source').length===2 && document.getElementById('btn-stop').disabled");
        assert.equal(await evaluate("imageRequests.filter(r=>r.prompt==='masked target').length"), 0, 'saved consumption rule cannot be downgraded into legacy compatibility');
        assert.match(await evaluate("document.querySelector('#mask-target .node-failure-summary').textContent"), /单图/);
    });
});

test('generation validates the complete real reference batch against its protocol capacity without disconnecting sources', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session,
        nodes: session.nodes.map(node => node.id === 'mask-source' ? { ...node, generationCount: 5 } : node),
        connections: session.connections.filter(edge => edge.id === 'reference')
    }, async app => {
        const { evaluate, waitFor } = app;
        await controlImages(app);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("imageRequests.some(r=>r.prompt==='masked target') && document.getElementById('btn-stop').disabled");
        assert.equal(await evaluate("imageRequests.find(r=>r.prompt==='masked target').references"), 5, 'all five originals reach the real edit request');
        await evaluate("(()=>{const field=document.getElementById('mask-source-generation-count');field.value='6';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('btn-run').click()})()");
        await waitFor("imageRequests.filter(r=>r.prompt==='mask source').length===11 && document.getElementById('btn-stop').disabled");
        assert.equal(await evaluate("imageRequests.filter(r=>r.prompt==='masked target').length"), 1, 'a six-image source is retained and blocked before the next request');
        assert.match(await evaluate("document.querySelector('#mask-target .node-failure-summary').textContent"), /最多.*5.*6/);
        await waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.nodes?.find(n=>n.id==='mask-source')?.mediaAssetKeys?.length===6})()");
        const edge = await evaluate("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved.connections.find(c=>c.id==='reference')})()");
        assert.deepEqual(edge, session.connections[0]);
    });
});

test('legacy multi-image masks keep their first original and persist that compatibility without shrinking the source batch', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session,
        nodes: session.nodes.map(node => node.id === 'mask-source' ? { ...node, generationCount: 2 } : node),
        connections: session.connections.map(edge => { const copy = { ...edge }; delete copy.maskConsumption; return copy; })
    }, async app => {
        const { evaluate, waitFor } = app;
        await controlImages(app);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("imageRequests.some(r=>r.prompt==='masked target') && document.getElementById('btn-stop').disabled");
        assert.deepEqual(await evaluate("imageRequests.filter(r=>r.prompt==='masked target').map(r=>({mask:r.maskData,references:r.references}))"),
            [{ mask: png, references: 2 }], 'legacy mask uses exactly the first original in one request');
        await waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.connections?.find(c=>c.id==='single-mask')?.maskConsumption==='legacy-first' && saved.nodes.find(n=>n.id==='mask-source')?.mediaAssetKeys?.length===2})()");
    });
});
