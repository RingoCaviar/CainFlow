import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const types = ['ImageImport', 'ImageGenerate', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave', 'CameraControl'];
const nodes = types.map((type, index) => ({ id: `aspect-${index}`, type, x: 400, y: 30, width: 320,
    height: 600, userResized: true, ...(type === 'ImageGenerate' ? { apiConfigId: 'image', providerId: 'p', prompt: 'controlled aspects', generationCount: 2 } : {}) }));
const connections = types.slice(2).map((type, index) => ({ id: `source-${index}`, from: { nodeId: 'aspect-0', port: 'image' },
    to: { nodeId: `aspect-${index + 2}`, port: type === 'ImageCompare' ? 'imageB' : type === 'ImageMerge' ? 'image_1' : 'image' }, type: 'image' }));

async function metrics(app, id) {
    return app.evaluate(`(()=>{const n=document.getElementById('${id}'),s=n.querySelector('.node-media-aspect-surface'),m=s?.querySelector('img,video');return {width:n.offsetWidth,height:n.offsetHeight,heightStyle:n.style.height,transition:getComputedStyle(n).transition,left:n.style.left,top:n.style.top,boxWidth:s?.offsetWidth,boxHeight:s?.offsetHeight,naturalWidth:m?.naturalWidth||m?.videoWidth,naturalHeight:m?.naturalHeight||m?.videoHeight,bodyHeight:n.querySelector(':scope>.node-body').offsetHeight}})()`);
}

function proportional(value, expectedWidth = 320) {
    assert.ok(value.boxWidth > 0 && value.naturalWidth > 0, JSON.stringify(value));
    assert.ok(Math.abs(value.boxHeight - value.boxWidth * value.naturalHeight / value.naturalWidth) <= 2, JSON.stringify(value));
    assert.ok(value.boxWidth >= value.width - 28, `the media uses the card width: ${JSON.stringify(value)}`);
    assert.ok(Math.abs(value.height - value.bodyHeight) <= 3, `the node adds only its border around the naturally sized content: ${JSON.stringify(value)}`);
    assert.equal(value.width, expectedWidth); assert.equal(value.left, '400px'); assert.equal(value.top, '30px');
}

async function resize(app, edge, dx, dy) {
    await app.evaluate("document.getElementById('aspect-1').click()");
    const handle = await app.evaluate(`(()=>{const h=document.querySelector('#aspect-1 [data-resize-edge=${edge}]'),r=h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...handle });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + dx, y: handle.y + dy, buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + dx, y: handle.y + dy, button: 'left', clickCount: 1 });
}

test('loaded image cards follow natural aspect at fixed node width, including batch changes and reload', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-1', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.aspectImages=[];for(const [width,height,color] of [[64,32,'red'],[32,64,'blue']]){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);aspectImages.push(canvas.toDataURL('image/png'));}const originalFetch=window.fetch;let request=0;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body)return new Response(JSON.stringify({data:[{b64_json:aspectImages[request++%2].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});return originalFetch(url,options)};` });
        await reloadAppBrowser(app);
        await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(aspectImages[0])).blob()],'wide.png',{type:'image/png'}));const input=document.getElementById('aspect-0-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.nodes.find(n=>n.id==='aspect-0')?.mediaAssetKeys?.length===1)");
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("document.getElementById('btn-stop').disabled&&document.getElementById('aspect-1-run-status').dataset.status==='completed'");
        for (const node of nodes) {
            if (node.type === 'CameraControl') {
                assert.equal(await app.evaluate("document.querySelector('#aspect-8 .camera-control-node-preview img')===null&&!document.getElementById('aspect-8').classList.contains('node-media-aspect')"), true, 'a camera placeholder has no fabricated image dimensions');
                continue;
            }
            await app.waitFor(`!!document.querySelector('#${node.id}.node-media-aspect .node-media-aspect-surface')`);
            proportional(await metrics(app, node.id));
        }
        await app.evaluate("document.querySelector('#aspect-1 [data-result-step=\"-1\"]').click()");
        await app.waitFor("document.querySelector('#aspect-1 .node-media-aspect-surface')?.style.getPropertyValue('--node-media-aspect')==='64 / 32'");
        const before = await metrics(app, 'aspect-1'); proportional(before);
        await resize(app, 'bottom', 0, 40);
        proportional(await metrics(app, 'aspect-1'), 400);
        await app.evaluate("document.querySelector('#aspect-1 [data-result-step=\"1\"]').click()");
        await app.waitFor("document.querySelector('#aspect-1 .node-media-aspect-surface')?.style.getPropertyValue('--node-media-aspect')==='32 / 64'");
        const portrait = await metrics(app, 'aspect-1'); proportional(portrait, 400);
        assert.ok(portrait.height > before.height * 2, JSON.stringify({ before, portrait }));
        await resize(app, 'right', 80, 0);
        proportional(await metrics(app, 'aspect-1'), 480);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.nodes.find(n=>n.id==='aspect-1')?.imagePreviewIndex===1)");
        await reloadAppBrowser(app);
        await app.waitFor("document.querySelector('#aspect-1 .node-media-aspect-surface')?.style.getPropertyValue('--node-media-aspect')==='32 / 64'");
        proportional(await metrics(app, 'aspect-1'), 480);
        const graph = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)");
        for (const edge of connections) assert.deepEqual(graph.connections.find(item => item.id === edge.id), edge);
    });
});
