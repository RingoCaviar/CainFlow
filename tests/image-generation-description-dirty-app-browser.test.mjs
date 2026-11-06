import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const originalFile = fileURLToPath(new URL('./fixtures/reference-red.png', import.meta.url));
const originalBase64 = (await readFile(originalFile)).toString('base64');
const generatedBase64 = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
const description = '这张原图是红色产品主体，请保留其轮廓与材质。';
const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'reference', type: 'ImageImport', x: 40, y: 80, width: 330, height: 300, userResized: true },
        { id: 'target', type: 'ImageGenerate', x: 650, y: 80, width: 330, height: 300, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'a clean product photo' }],
    connections: [{ id: 'original-reference-edge', from: { nodeId: 'reference', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 7 }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value)");

async function click(app, selector, count = 1) {
    const position = await app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    const hit = await app.evaluate(`(()=>{const target=document.elementFromPoint(${position.x},${position.y});return {reachable:document.querySelector(${JSON.stringify(selector)}).contains(target),target:target?.outerHTML.slice(0,240),position:${JSON.stringify(position)}}})()`);
    assert.equal(hit.reachable, true, `the actual control is reachable: ${selector} ${JSON.stringify(hit)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: count });
}

async function generate(app, requestCount) {
    const previousFingerprint = (await saved(app)).nodes.find(node => node.id === 'target')?.generationRevision?.successFingerprint;
    await app.evaluate("document.getElementById('target').click()");
    await app.waitFor("!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId==='target'");
    await app.evaluate("document.querySelector('[data-parameter-action=generate]').click()");
    await app.waitFor(`descriptionRequests.length===${requestCount}&&document.getElementById('target-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled`);
    await app.waitFor("!document.querySelector('[data-node-id=target] [data-image-generation-dirty]')");
    // A previous clean record may still be on disk during the session debounce.
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>{const node=record.value.nodes.find(node=>node.id==='target');return node?.generationRevision?.dirty===false&&node.generationRevision.successFingerprint!==${JSON.stringify(previousFingerprint) || 'undefined'}&&node.mediaAssetKeys?.length===1})`);
}

test('confirming an imported original description marks its generation target pending and the next real request commits that described recipe across reopen', { timeout: 60000 }, async () => {
    await withAppBrowser(configuration, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.descriptionRequests=[];const descriptionFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const form=options.body instanceof FormData,body=form?Object.fromEntries(options.body.entries()):JSON.parse(options.body);if(typeof body.prompt==='string'){const references=form?(options.body.getAll('image[]').length?options.body.getAll('image[]'):[options.body.get('image')].filter(Boolean)):[];descriptionRequests.push({prompt:body.prompt,references:await Promise.all(references.map(async image=>btoa(String.fromCharCode(...new Uint8Array(await image.arrayBuffer())))))});return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(generatedBase64)}}]}),{headers:{'Content-Type':'application/json'}});}}return descriptionFetch(url,options)};` });
        await reloadAppBrowser(app);
        const document = await app.send('DOM.getDocument');
        const input = await app.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#reference-file' });
        await app.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [originalFile] });
        await app.waitFor("document.querySelector('#reference-drop img')?.naturalWidth>0");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='reference')?.mediaAssetKeys?.length===1)");
        await generate(app, 1);
        const baseline = await saved(app), sourceKeys = baseline.nodes.find(node => node.id === 'reference').mediaAssetKeys;
        assert.deepEqual(await app.evaluate('descriptionRequests[0].references'), [originalBase64]);
        assert.doesNotMatch(await app.evaluate('descriptionRequests[0].prompt'), /红色产品主体/);
        await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click());document.querySelector('[data-parameter-action=close]').click()");
        await click(app, '#reference-drop', 2);
        await app.waitFor("document.querySelector('.fullscreen-overlay img')?.naturalWidth>0&&document.querySelector('.fullscreen-description-btn')");
        await click(app, '.fullscreen-overlay .preview-action-reveal');
        await app.waitFor("document.querySelector('.fullscreen-description-btn').getBoundingClientRect().right<=innerWidth");
        await click(app, '.fullscreen-description-btn');
        await app.waitFor("!document.querySelector('.fullscreen-description-dialog').classList.contains('hidden')");
        await app.send('Input.insertText', { text: description });
        await click(app, '.fullscreen-description-confirm');
        await app.waitFor("document.querySelector('.fullscreen-description-dialog').classList.contains('hidden')");
        assert.equal(await app.evaluate('descriptionRequests.length'), 1, 'confirming metadata never runs the generation target');
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='target')?.generationRevision?.dirty===true)");
        assert.ok(await app.evaluate("document.querySelector('#target-image-results img')?.naturalWidth>0"), 'editing only the description retains the readable previous result');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await generate(app, 2);
        assert.match(await app.evaluate('descriptionRequests[1].prompt'), /参考图 1：这张原图是红色产品主体，请保留其轮廓与材质。/);
        assert.deepEqual(await app.evaluate('descriptionRequests[1].references'), [originalBase64]);
        await waitForAutosave(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='target')?.generationRevision?.dirty===false)");
        const completed = await saved(app), source = completed.nodes.find(node => node.id === 'reference'), target = completed.nodes.find(node => node.id === 'target');
        assert.equal(source.imageDescription, description); assert.deepEqual(source.mediaAssetKeys, sourceKeys);
        assert.equal(target.generationRevision.dirty, false);
        assert.deepEqual(completed.connections, baseline.connections);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("!document.querySelector('[data-node-id=target] [data-image-generation-dirty]')"), true);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'reference').imageDescription, description);
        assert.equal(await app.evaluate('descriptionRequests.length'), 0, 'reopen restores the confirmed recipe without a provider request');
    });
});
