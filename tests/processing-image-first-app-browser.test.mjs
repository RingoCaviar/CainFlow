import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const edge = (source, target) => ({ id: `${source}-${target}`, from: { nodeId: source, port: 'image' }, to: { nodeId: target, port: 'image' }, type: 'image' });
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");

async function openParameters(app, id) {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}

async function closeParameters(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
}

async function storeWorkflows(app, graphs) {
    for (const { name, ...graph } of graphs) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
}

async function activateWorkflow(app, name, nodeId = 'color') {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor(`Boolean(document.getElementById(${JSON.stringify(nodeId)}))`);
    await openParameters(app, nodeId);
}

async function change(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});${typeof value === 'boolean' ? `input.checked=${value}` : `input.value=${JSON.stringify(String(value))}`};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function importPattern(app, id, mime = 'image/png') {
    // A real file-input import supplies nonuniform pixels for quality, white
    // balance and four independent color controls. No node output is injected.
    await app.evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=192;canvas.height=128;const context=canvas.getContext('2d'),pixels=context.createImageData(192,128);for(let y=0;y<128;y++)for(let x=0;x<192;x++){const color=x<64?[180,150,120]:x<128?[190,100,70]:[60,130,180],offset=(y*192+x)*4,noise=((x*13+y*17)%19)-9;for(let c=0;c<3;c++)pixels.data[offset+c]=color[c]+noise;pixels.data[offset+3]=255;}context.putImageData(pixels,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,${JSON.stringify(mime)},0.98)),transfer=new DataTransfer();transfer.items.add(new File([blob],'processing-reference.${mime === 'image/jpeg' ? 'jpg' : 'png'}',{type:${JSON.stringify(mime)}}));const input=document.getElementById(${JSON.stringify(`${id}-file`)});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys?.length===1)`);
}

async function assetImage(app, id) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys?.length>0)`);
    return app.evaluate(`(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value,node=graph.nodes.find(node=>node.id===${JSON.stringify(id)}),key=node.mediaAssetKeys[0],response=await fetch('/api/storage/assets/'+encodeURIComponent(key)),blob=await response.blob(),image=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,image.width,image.height).data;let checksum=0;for(let offset=0;offset<pixels.length;offset++)checksum=(checksum+pixels[offset]*(offset%97+1))%2147483647;return {key,width:image.width,height:image.height,mime:blob.type,bytes:blob.size,checksum,pixel:Array.from(context.getImageData(Math.floor(image.width/4),Math.floor(image.height/2),1,1).data)};})()`);
}

async function waitForAssetChange(app, id, previousKey) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const key=document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys?.[0];return Boolean(key)&&key!==${JSON.stringify(previousKey)}})`);
}

async function run(app) {
    await app.evaluate("document.getElementById('btn-run').click()");
    await app.waitFor("document.getElementById('btn-stop').disabled && !document.getElementById('btn-run').disabled");
}

test('resize edits in the lower editor produce real dimensions and JPEG quality after closing and reopening', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'processing-import', type: 'ImageImport', x: 30, y: 40 },
        { id: 'resize', type: 'ImageResize', x: 500, y: 40, width: 350, height: 370, userResized: true, customTitle: '保留缩放标题' },
        { id: 'note', type: 'Text', x: 900, y: 40, text: 'selection target' }
    ], connections: [edge('processing-import', 'resize')] }, async app => {
        await importPattern(app, 'processing-import', 'image/jpeg');
        await app.waitFor("document.querySelector('#resize-resize-preview img')?.naturalWidth>0");
        const source = (await saved(app)).nodes.find(node => node.id === 'processing-import');
        const geometry = await app.evaluate("(()=>{const node=document.getElementById('resize');return [node.style.left,node.style.top,node.offsetWidth]})()");
        await openParameters(app, 'resize');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('resize-scale-percent')) && !document.getElementById('resize').contains(document.getElementById('resize-scale-percent'))"), true);
        await change(app, 'resize-scale-percent', 50);
        await app.waitFor("document.getElementById('resize-resize-size-label').textContent.includes('96 × 64')");
        await app.evaluate("document.querySelector('.image-resize-mode-btn[data-target=resize][data-mode=dimensions]').click()");
        await change(app, 'resize-target-width', 96);
        await app.waitFor("document.getElementById('resize-target-height').value==='64'");
        await change(app, 'resize-keep-aspect', false);
        await change(app, 'resize-target-height', 40);
        await change(app, 'resize-quality', 95);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='resize');return node?.quality===95&&node?.outputHeight===40})");
        const highQuality = await assetImage(app, 'resize');
        await change(app, 'resize-quality', 20);
        await waitForAssetChange(app, 'resize', highQuality.key);
        const lowQuality = await assetImage(app, 'resize');
        assert.deepEqual([lowQuality.width, lowQuality.height, lowQuality.mime], [96, 40, 'image/jpeg']);
        assert.ok(lowQuality.bytes < highQuality.bytes, 'the quality control changes the encoded original bytes');
        assert.ok(lowQuality.bytes > 200);
        assert.match(await app.evaluate("document.getElementById('resize-resize-bytes-label').textContent"), /JPEG|JPG|jpeg/);
        await closeParameters(app);
        await app.evaluate("document.getElementById('note').click()");
        await run(app);
        const output = await assetImage(app, 'resize');
        assert.deepEqual([output.width, output.height, output.mime], [96, 40, 'image/jpeg']);
        const graph = await saved(app), node = graph.nodes.find(node => node.id === 'resize');
        assert.deepEqual([node.resizeMode, node.scalePercent, String(node.targetWidth), String(node.targetHeight), node.keepAspect, node.quality], ['dimensions', 50, '96', '40', false, 20]);
        assert.equal(node.outputQuality, 0.2);
        assert.equal(node.estimatedBytes, output.bytes);
        assert.deepEqual(graph.nodes.find(node => node.id === 'processing-import').mediaAssetKeys, source.mediaAssetKeys);
        assert.deepEqual(graph.connections, [edge('processing-import', 'resize')]);
        await reloadAppBrowser(app);
        await openParameters(app, 'resize');
        assert.deepEqual(await app.evaluate("['resize-mode','scale-percent','target-width','target-height','quality'].map(name=>document.getElementById('resize-'+name).value).concat(document.getElementById('resize-keep-aspect').checked)"), ['dimensions', '50', '96', '40', '20', false]);
        assert.deepEqual(await app.evaluate("(()=>{const node=document.getElementById('resize');return [node.style.left,node.style.top,node.offsetWidth]})()"), geometry);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'resize').customTitle, '保留缩放标题');
    });
});

test('resize and color consume the primary original once while the generated source retains its complete batch', { timeout: 45000 }, async () => {
    const images = await Promise.all(['red', 'orange', 'blue'].map(async color => (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'source', type: 'ImageGenerate', x: 20, y: 30, apiConfigId: 'image', providerId: 'p', prompt: 'processing batch', generationCount: 3 },
        { id: 'resize', type: 'ImageResize', x: 420, y: 30, scalePercent: 50 },
        { id: 'color', type: 'ColorReset', x: 750, y: 30, whiteBalanceMode: 'original' }
    ], connections: [edge('source', 'resize'), edge('source', 'color')] }, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.processingRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){const images=${JSON.stringify(images)},index=processingRequests.length;processingRequests.push(body);return new Response(JSON.stringify({data:[{b64_json:images[index%images.length]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options);};` });
        await reloadAppBrowser(app);
        await run(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='source')?.mediaAssetKeys?.length===3 && document.value.nodes.find(node=>node.id==='resize')?.mediaAssetKeys?.length===1 && document.value.nodes.find(node=>node.id==='color')?.mediaAssetKeys?.length===1)");
        const graph = await saved(app), source = graph.nodes.find(node => node.id === 'source');
        const primary = await assetImage(app, 'source'), resize = await assetImage(app, 'resize'), color = await assetImage(app, 'color');
        assert.deepEqual(color.pixel, primary.pixel, 'color keeps the first original instead of the final batch item');
        assert.deepEqual(resize.pixel, primary.pixel, 'resize keeps the first original instead of processing every item');
        assert.deepEqual([resize.width, resize.height], [512, 384]);
        assert.equal(color.key, source.mediaAssetKeys[0], 'an unchanged color result reuses the primary media identity');
        assert.equal(await app.evaluate('processingRequests.length'), 3);
        await app.evaluate("document.querySelector('#source-image-results .image-node-result-count').click();document.querySelector('#source-image-results [data-result-index=\"2\"]').click()");
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count').textContent==='3 / 3'");
        await reloadAppBrowser(app);
        assert.deepEqual((await saved(app)).nodes.find(node => node.id === 'source').mediaAssetKeys, source.mediaAssetKeys);
        assert.deepEqual((await saved(app)).connections, graph.connections);
        assert.deepEqual((await assetImage(app, 'color')).pixel, primary.pixel);
        assert.equal(await app.evaluate('processingRequests.length'), 0, 'reopening never regenerates the retained source');
        for (const [id, surface] of [['resize', 'resize-preview'], ['color', 'color-preview']]) {
            const retained = await assetImage(app, id);
            await openParameters(app, id);
            await app.evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();document.querySelector('#image-parameter-panel [data-input-action=disconnect]').click()})()");
            await app.waitFor(`document.getElementById('${id}-${surface}').dataset.processingState==='stale'`);
            await app.waitFor(`document.getElementById('${id}').innerText.includes('预览未更新')`);
            assert.ok(await app.evaluate(`document.querySelector('#${id}-${surface} img')?.naturalWidth>0`), 'disconnecting a processing input retains its readable previous result');
            assert.equal((await assetImage(app, id)).key, retained.key);
            await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>!document.value?.connections.some(connection=>connection.to.nodeId===${JSON.stringify(id)}))`);
            const disconnected = await saved(app);
            assert.deepEqual(disconnected.nodes.find(node => node.id === 'source').mediaAssetKeys, source.mediaAssetKeys);
            assert.equal(disconnected.connections.some(connection => connection.to.nodeId === id), false);
            if (id === 'resize') assert.deepEqual(disconnected.connections, [edge('source', 'color')], 'disconnecting resize leaves the other processing connection intact');
        }
    });
});

test('color white balance, sampling and each color slider change real pixels and survive workflow activation and reopening', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        const graphs = [
            { name: 'Processing A', workflowId: 'processing-workflow-a', nodes: [{ id: 'processing-import', type: 'ImageImport', x: 20, y: 30 }, { id: 'color', type: 'ColorReset', x: 450, y: 30, width: 350, height: 350, userResized: true }], connections: [edge('processing-import', 'color')] },
            { name: 'Processing B', workflowId: 'processing-workflow-b', nodes: [{ id: 'color', type: 'ColorReset', x: 200, y: 30, temperature: -9, saturation: 7 }], connections: [] }
        ];
        await storeWorkflows(app, graphs);
        await activateWorkflow(app, 'Processing A');
        await importPattern(app, 'processing-import');
        await app.waitFor("document.querySelector('#color-color-preview img')?.naturalWidth>0");
        await openParameters(app, 'color');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('color-temperature')) && !document.getElementById('color').contains(document.getElementById('color-temperature'))"), true);
        const original = await assetImage(app, 'color');
        await change(app, 'color-white-balance', 'auto');
        await waitForAssetChange(app, 'color', original.key);
        assert.notEqual((await assetImage(app, 'color')).checksum, original.checksum, 'automatic white balance changes the original pixels');
        await app.waitFor("document.getElementById('color-white-balance-status').dataset.status==='applied'");
        await app.evaluate("document.getElementById('color-white-balance-picker').click()");
        await app.waitFor("document.getElementById('color-white-balance-picker').getAttribute('aria-pressed')==='true'");
        await app.evaluate("(()=>{const image=document.querySelector('#color-color-preview img'),rect=image.getBoundingClientRect();image.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:rect.left+rect.width/6,clientY:rect.top+rect.height/2}));})()");
        await app.waitFor("document.getElementById('color-white-balance').value==='custom' && document.getElementById('color-white-balance-picker').getAttribute('aria-pressed')==='false'");
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false, 'the white-balance sampling gesture takes priority over original viewing');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false);
        let previous = await assetImage(app, 'color');
        for (const [name, value] of [['temperature', 22], ['tint', -17], ['vibrance', 31], ['saturation', -24]]) {
            await change(app, `color-${name}`, value);
            await waitForAssetChange(app, 'color', previous.key);
            const next = await assetImage(app, 'color');
            assert.notEqual(next.checksum, previous.checksum, `${name} changes decoded output pixels`);
            previous = next;
        }
        await closeParameters(app);
        await run(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='color');return node?.whiteBalanceMode==='custom'&&node?.whiteBalanceSamplePoint&&node?.temperature===22&&node?.saturation===-24})");
        const before = (await saved(app)).nodes.find(node => node.id === 'color');
        assert.equal(before.whiteBalanceStatus, 'applied');
        assert.ok(before.whiteBalanceSamplePoint.xRatio > 0 && before.whiteBalanceSamplePoint.xRatio < 0.34);
        assert.notDeepEqual(before.customWhiteBalanceGains, { r: 1, g: 1, b: 1 });
        assert.deepEqual([before.temperature, before.tint, before.vibrance, before.saturation], [22, -17, 31, -24]);
        await waitForAutosave(app);
        await activateWorkflow(app, 'Processing B');
        assert.deepEqual(await app.evaluate("['temperature','saturation'].map(name=>document.getElementById('color-'+name).value)"), ['-9', '7']);
        await activateWorkflow(app, 'Processing A');
        assert.deepEqual(await app.evaluate("['white-balance','temperature','tint','vibrance','saturation'].map(name=>document.getElementById('color-'+name).value)"), ['custom', '22', '-17', '31', '-24']);
        await reloadAppBrowser(app);
        await openParameters(app, 'color');
        const after = (await saved(app)).nodes.find(node => node.id === 'color');
        for (const key of ['whiteBalanceMode', 'whiteBalanceSamplePoint', 'whiteBalanceStatus', 'whiteBalanceMessage', 'customWhiteBalanceGains', 'temperature', 'tint', 'vibrance', 'saturation', 'mediaAssetKeys']) assert.deepEqual(after[key], before[key], `${key} survives workflow activation and reload`);
        assert.deepEqual([after.width, after.userResized], [350, true]);
        assert.deepEqual([...(await assetImage(app, 'color')).pixel], [...previous.pixel]);
    });
});

test('background processing uses A settings and media while B with the same node IDs stays unchanged', { timeout: 60000 }, async () => {
    const original = (await readFile(new URL('./fixtures/reference-orange.png', import.meta.url))).toString('base64');
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.processingBackgroundRequests=0;window.processingBackgroundPending=false;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body&&typeof JSON.parse(options.body).prompt==='string'){processingBackgroundRequests++;processingBackgroundPending=true;await new Promise(resolve=>window.releaseProcessingImage=resolve);return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(original)}}]}),{headers:{'Content-Type':'application/json'}});}return nativeFetch(url,options);};` });
        await reloadAppBrowser(app);
        await storeWorkflows(app, [
            { name: 'Background A', workflowId: 'processing-background-a', nodes: [
                { id: 'source', type: 'ImageGenerate', x: 10, y: 20, apiConfigId: 'image', providerId: 'p', prompt: 'held processing original' },
                { id: 'resize', type: 'ImageResize', x: 380, y: 20 },
                { id: 'color', type: 'ColorReset', x: 720, y: 20 }
            ], connections: [edge('source', 'resize'), edge('resize', 'color')] },
            { name: 'Background B', workflowId: 'processing-background-b', nodes: [
                { id: 'resize', type: 'ImageResize', x: 50, y: 20, resizeMode: 'dimensions', targetWidth: '33', targetHeight: '55', keepAspect: true, quality: 83 },
                { id: 'color', type: 'ColorReset', x: 450, y: 20, temperature: -9, tint: 6, vibrance: -3, saturation: 7 }
            ], connections: [] }
        ]);
        await activateWorkflow(app, 'Background A', 'resize');
        await app.evaluate("document.querySelector('.image-resize-mode-btn[data-target=resize][data-mode=dimensions]').click()");
        await change(app, 'resize-keep-aspect', false);
        await change(app, 'resize-target-width', 80);
        await change(app, 'resize-target-height', 40);
        await change(app, 'resize-quality', 57);
        await openParameters(app, 'color');
        await change(app, 'color-temperature', 22);
        await change(app, 'color-tint', -17);
        await change(app, 'color-vibrance', 31);
        await change(app, 'color-saturation', -24);
        await closeParameters(app);
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor('processingBackgroundPending===true');
        await activateWorkflow(app, 'Background B', 'resize');
        assert.deepEqual(await app.evaluate("['resize-mode','target-width','target-height','quality'].map(name=>document.getElementById('resize-'+name).value).concat(document.getElementById('resize-keep-aspect').checked)"), ['dimensions', '33', '55', '83', true]);
        await openParameters(app, 'color');
        assert.deepEqual(await app.evaluate("['temperature','tint','vibrance','saturation'].map(name=>document.getElementById('color-'+name).value)"), ['-9', '6', '-3', '7']);
        assert.equal(await app.evaluate("document.querySelector('.workflow-item[data-name=\"Background A\"]').classList.contains('is-running')"), true);
        await app.evaluate('releaseProcessingImage()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Background A\"]').classList.contains('is-running')");
        const untouched = await saved(app);
        assert.equal(untouched.activeWorkflowId, 'processing-background-b');
        assert.ok(untouched.nodes.every(node => !node.mediaAssetKeys?.length), 'A completion cannot put its output into the visible B nodes');
        assert.deepEqual(untouched.connections, []);
        await activateWorkflow(app, 'Background A', 'resize');
        assert.deepEqual(await app.evaluate("['resize-mode','target-width','target-height','quality'].map(name=>document.getElementById('resize-'+name).value).concat(document.getElementById('resize-keep-aspect').checked)"), ['dimensions', '80', '40', '57', false]);
        const resized = await assetImage(app, 'resize'), colored = await assetImage(app, 'color');
        assert.deepEqual([resized.width, resized.height, colored.width, colored.height], [80, 40, 80, 40], 'the background result uses A dimensions instead of the visible B controls');
        assert.notDeepEqual(colored.pixel, resized.pixel, 'A color settings are actually applied to the resized original');
        await openParameters(app, 'color');
        assert.deepEqual(await app.evaluate("['temperature','tint','vibrance','saturation'].map(name=>document.getElementById('color-'+name).value)"), ['22', '-17', '31', '-24']);
        const completed = await saved(app);
        assert.deepEqual(completed.connections, [edge('source', 'resize'), edge('resize', 'color')]);
        assert.equal(completed.nodes.find(node => node.id === 'source').mediaAssetKeys.length, 1);
        assert.equal(await app.evaluate('processingBackgroundRequests'), 1, 'switching back does not regenerate A');
        await waitForAutosave(app);
        const ownership = await app.evaluate("Promise.all(['processing-background-a','processing-background-b'].map(id=>fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(id)).then(response=>response.json()).then(result=>result.owners.filter(owner=>owner.ownerType==='workflow-node'))))");
        assert.deepEqual(ownership[0].find(owner => owner.ownerId === 'resize')?.assetKeys, [resized.key]);
        assert.deepEqual(ownership[0].find(owner => owner.ownerId === 'color')?.assetKeys, [colored.key]);
        assert.ok(ownership[1].every(owner => !owner.assetKeys.length), 'saved background results belong to A workflow-node owners');
        await reloadAppBrowser(app);
        assert.equal((await assetImage(app, 'resize')).key, resized.key);
        assert.equal((await assetImage(app, 'color')).key, colored.key);
        await activateWorkflow(app, 'Background B');
        assert.deepEqual(await app.evaluate("['temperature','tint','vibrance','saturation'].map(name=>document.getElementById('color-'+name).value)"), ['-9', '6', '-3', '7']);
        assert.ok((await saved(app)).nodes.every(node => !node.mediaAssetKeys?.length));
    });
});
