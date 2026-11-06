import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

const images = await Promise.all(['red', 'blue', 'orange'].map(async color => 'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p', 'q'] },
        { id: 'image-other', modelId: 'gpt-image-1.5', name: '另一图片配置', protocol: 'openai', taskType: 'image', providerIds: ['p', 'q'] },
        { id: 'google', modelId: 'gemini-image', name: '受控参考生图', protocol: 'google', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '供应商甲', endpoint: 'https://controlled.test/v1', apikey: 'test' }, { id: 'q', name: '供应商乙', endpoint: 'https://other-controlled.test/v1', apikey: 'test' }]
};
const node = (id, x, y, extra = {}) => ({ id, type: 'ImageGenerate', x, y, width: 330, height: 300, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: id, ...extra });
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const fullFailure = '本轮真实失败：' + 'ProviderUnbrokenFailureToken'.repeat(35) + ' · complete-cause-end';

async function controlled(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.statusRequests=[];window.statusHold=[];window.statusPending={};window.statusRelease={};window.statusFailures={};window.statusMessages={};const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const form=options.body instanceof FormData,body=form?Object.fromEntries(options.body.entries()):JSON.parse(options.body);if(body.contents||typeof body.prompt==='string'){const label=body.contents?'target':body.prompt.split(' ')[0];const record=form?{prompt:body.prompt,mask:body.mask instanceof Blob,references:await Promise.all((options.body.getAll('image[]').length?options.body.getAll('image[]'):[options.body.get('image')].filter(Boolean)).map(async image=>btoa(String.fromCharCode(...new Uint8Array(await image.arrayBuffer())))))}:body;const encoded=new Headers(options.headers).get('x-target-url-b64');statusRequests.push({label,body:record,url:encoded?atob(encoded.replace(/-/g,'+').replace(/_/g,'/')):''});if(statusFailures[label]>0){statusRequests.at(-1).failed=true;statusFailures[label]--;return new Response(JSON.stringify({error:{message:statusMessages[label]||label+' 本轮真实失败'}}),{status:500,headers:{'Content-Type':'application/json'}});}if(statusHold.includes(label)){statusPending[label]=true;try{await new Promise((resolve,reject)=>{statusRelease[label]=resolve;options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});}finally{statusPending[label]=false;}}const originals=${JSON.stringify(images)},index=label==='target'?1:(statusRequests.filter(request=>request.label===label).length-1)%originals.length,b64=originals[index].split(',')[1];return new Response(JSON.stringify(body.contents?{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:b64}}]}}]}:{data:[{b64_json:b64}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options)};` });
    await reloadAppBrowser(app);
}

async function open(app, id, group) {
    if (group === 'reference' || group === 'advanced') group = 'more';
    await app.evaluate(`document.querySelectorAll('.notice-close').forEach(button=>button.click());document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
    if (group) await app.evaluate(`(()=>{const button=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=${group}]');if(button.getAttribute('aria-expanded')!=='true')button.click()})()`);
}

async function change(app, id, value) {
    await app.evaluate(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function start(app, id, selected = false) {
    await app.evaluate(`(()=>{const root=document.getElementById(${JSON.stringify(id)});${selected ? "root.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:600,clientY:200}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));" : ''}root.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:200}));document.getElementById('${selected ? 'context-menu-run-selected' : 'context-menu-run-to-here'}').click()})()`);
}

async function completed(app, id) {
    await app.waitFor(`document.getElementById('${id}-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled`);
}

async function runSuccess(app, id, selected = false) {
    const previous = await app.evaluate('statusRequests.length');
    await start(app, id, selected);
    await app.waitFor(`statusRequests.length>${previous}`);
    await completed(app, id);
}

async function activate(app, name) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]'))`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')===true`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
}

async function click(app, selector, hold = 0) {
    await app.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el.closest('#image-parameter-panel'))el.scrollIntoView({block:'center'})})()`);
    const center = `(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`;
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await app.evaluate(center) });
    try {
        await app.waitFor(`(()=>{const button=document.querySelector(${JSON.stringify(selector)}),rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))})()`);
    } catch (error) {
        throw new Error(`The native control remains unreachable: ${selector} ` + JSON.stringify(await app.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)}),rect=button.getBoundingClientRect();return {rect:rect.toJSON(),hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.outerHTML.slice(0,400)}})()`)), { cause: error });
    }
    const point = await app.evaluate(center);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    if (hold) await delay(hold);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}

async function upload(app, id, index = 0) {
    await uploadImageOriginal(app, id, images[index]);
}

async function expectDirty(app, id, dirty) {
    assert.equal(await app.evaluate(`document.querySelector('[data-node-id="${id}"] [data-image-generation-dirty]')`), null, 'pending settings do not add a presentation row');
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id===${JSON.stringify(id)});return !!node&&node.generationRevision?.dirty===${dirty}})`);
}

async function expectUnconfirmed(app, id) {
    assert.equal(await app.evaluate(`document.querySelector('[data-node-id="${id}"] [data-image-generation-dirty]')`), null);
    assert.equal((await saved(app)).nodes.find(node=>node.id===id).generationRevision, undefined, 'a node without generation history has no confirmed recipe');
}

async function expectSavedOutputCleared(app, id, oldKeys) {
    await waitForAutosave(app);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id===${JSON.stringify(id)});return !!node&&!(node.mediaAssetKeys?.length)&&!node.imageAssetKey&&node.imageAssetReady!==true})`);
    const record = (await saved(app)).nodes.find(node => node.id === id);
    assert.deepEqual(record.mediaAssetKeys || [], [], 'an empty current attempt cannot serialize the previous result references');
    assert.ok(!oldKeys.includes(record.imageAssetKey), 'the previous asset pointer is not revived by saving');
    assert.notEqual(record.imageAssetReady, true, 'an empty attempt cannot advertise the old output as ready');
}

test('waiting and running clear this attempt output and failure while preserving outside failures and locking the open reference editor', { timeout: 90000 }, async () => {
    const connection = { id: 'input-source', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0 };
    await withAppBrowser({ ...configuration, nodes: [node('source', 20, 120), node('target', 500, 120, { apiConfigId: 'google' }),
        { id: 'replacement', type: 'ImageImport', x: 20, y: 550 }, node('outside', 1000, 120), node('disabled-old', 1450, 120)], connections: [connection] }, async app => {
        await controlled(app); await upload(app, 'replacement', 1);
        await start(app, 'target'); await completed(app, 'target');
        await app.waitFor("document.querySelector('#target-image-results img')?.naturalWidth>0");
        for (const id of ['outside', 'disabled-old']) {
            await app.evaluate(`statusFailures[${JSON.stringify(id)}]=1`); await start(app, id);
            await app.waitFor(`document.getElementById('${id}-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled`);
            await app.evaluate("document.querySelector('#modal-error .modal-close')?.click()");
        }
        await waitForAutosave(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections.length===1)");
        const originalConnections = (await saved(app)).connections;
        const oldKeys = (await saved(app)).nodes.find(node => node.id === 'target').mediaAssetKeys;
        assert.equal(oldKeys.length, 1);
        await app.evaluate("document.querySelector('#disabled-old .node-bypass-btn').click()");
        await open(app, 'target'); await change(app, 'target-prompt', 'target edited before cancelled attempt');
        await expectDirty(app, 'target', true);
        await open(app, 'target', 'reference');
        await app.evaluate("statusHold=['source','target']"); await start(app, 'target');
        await app.waitFor("statusPending.source===true&&document.getElementById('target-run-status').textContent==='待运行'");
        assert.equal(await app.evaluate("document.getElementById('target-image-results').hidden"), true, 'entering waiting immediately removes the previous successful result');
        await expectSavedOutputCleared(app, 'target', oldKeys);
        assert.equal(await app.evaluate("document.getElementById('target-generation-progress').checkVisibility()"), false, 'waiting has no invented numerical progress');
        assert.equal(await app.evaluate("(()=>{const controls=[...document.querySelectorAll('.image-reference-overview .image-reference-drag')];return controls.length===1&&controls.every(control=>control.dataset.reorderDisabled==='true')})()"), true, 'reference mutation obeys the runtime lock');
        assert.equal(await app.evaluate("document.getElementById('target-assistant')"), null);
        for (const id of ['outside', 'disabled-old']) assert.match(await app.evaluate(`document.querySelector('[data-node-id=${id}] .node-failure-summary').textContent`), /本轮真实失败/);
        await app.evaluate("statusHold=['target'];statusRelease.source()");
        await app.waitFor("statusPending.target===true&&document.getElementById('target-run-status').textContent==='运行中'");
        assert.doesNotMatch(await app.evaluate("document.getElementById('target-generation-progress').textContent"), /\d+\s*%/);
        // A bottom-clamped parameter editor can overlap its card. Dismiss it
        // through the supported keyboard action before using the card cancel.
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await click(app, '#target .node-run-cancel-btn', 150);
        assert.equal(await app.evaluate("statusPending.target&&document.getElementById('target-run-status').textContent==='运行中'"), true, 'a short native press cannot cancel the protected request');
        await click(app, '#target .node-run-cancel-btn', 2150);
        await app.waitFor("document.getElementById('target-run-status').textContent==='已取消'&&document.getElementById('btn-stop').disabled");
        await expectDirty(app, 'target', true);
        assert.equal(await app.evaluate("document.getElementById('target-image-results').hidden"), true);
        await expectSavedOutputCleared(app, 'target', oldKeys);
        await app.evaluate(`statusHold=[];statusFailures.target=1;statusMessages.target=${JSON.stringify(fullFailure)}`); await start(app, 'target', true);
        await app.waitFor("document.getElementById('target-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled");
        assert.match(await app.evaluate("document.querySelector('[data-node-id=target] .node-failure-summary').textContent"), /本轮真实失败/);
        assert.ok((await app.evaluate("document.querySelector('[data-node-id=target] .node-failure-summary').textContent")).length < fullFailure.length, 'the card presents a short cause rather than the whole provider payload');
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click()");
        await expectSavedOutputCleared(app, 'target', oldKeys);
        assert.ok(await app.evaluate("(()=>{const summary=document.querySelector('[data-node-id=target] .node-failure-summary');return summary.scrollWidth<=summary.clientWidth+1})()"), 'unbroken provider words wrap within the short card summary');
        await open(app, 'target', 'reference');
        await click(app, '[data-node-id=target] [data-image-run-action=details]');
        await app.waitFor("!document.querySelector('.image-parameter-settings-popup:popover-open')");
        assert.equal(await app.evaluate("document.getElementById('modal-error').classList.contains('active')"), false, 'the first outside click dismisses More settings');
        await click(app, '[data-node-id=target] [data-image-run-action=details]');
        await app.waitFor("document.getElementById('modal-error').classList.contains('active')");
        await app.evaluate("(()=>{const full=document.getElementById('btn-show-full-log');if(!full.classList.contains('hidden'))full.click()})()");
        const errorDetail = await app.evaluate("document.getElementById('error-modal-msg').textContent+'\\n'+document.getElementById('error-modal-detail').textContent");
        assert.ok(errorDetail.includes(fullFailure), `the public error details retain the complete provider cause: ${JSON.stringify({ length: errorDetail.length, start: errorDetail.slice(0, 180), end: errorDetail.slice(-140) })}`);
        assert.doesNotMatch(errorDetail, /key=test|Bearer test|"apikey"\s*:\s*"test"/i, 'complete diagnostics still redact provider secrets');
        await app.evaluate("document.querySelector('#modal-error .modal-close').click()");
        await open(app, 'target');
        assert.ok(await app.evaluate(`document.getElementById('image-parameter-panel').contains(document.getElementById('target-error'))&&document.getElementById('target-error').textContent.includes(${JSON.stringify(fullFailure)})`), 'the lower parameter window also preserves the full error');
        assert.ok(await app.evaluate("(()=>{const detail=document.getElementById('target-error');return detail.scrollWidth<=detail.clientWidth+1})()"));
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click();statusHold=['source']"); await start(app, 'target');
        await app.waitFor("statusPending.source===true&&document.getElementById('target-run-status').textContent==='待运行'");
        assert.equal(await app.evaluate("document.getElementById('target-error').textContent"), '');
        assert.equal(await app.evaluate("document.querySelector('[data-node-id=target] .node-failure-summary').classList.contains('hidden')"), true);
        for (const id of ['outside', 'disabled-old']) assert.match(await app.evaluate(`document.querySelector('[data-node-id=${id}] .node-failure-summary').textContent`), /本轮真实失败/);
        await app.evaluate("statusHold=[];statusRelease.source()"); await completed(app, 'target');
        await expectDirty(app, 'target', false);
        assert.deepEqual((await saved(app)).connections, originalConnections);
        assert.equal(await app.evaluate("Boolean(document.getElementById('target-run-to-here')||document.getElementById('target-run-log'))"), false);
    });
});

test('effective settings mark generation pending while browsing, layout, selection, window presentation and reload preserve a confirmed recipe', { timeout: 90000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [node('dirty-node', 60, 120, { generationCount: 2 }), { id: 'note', type: 'Text', x: 900, y: 120, text: 'unrelated selection' }], connections: [] }, async app => {
        await controlled(app);
        await expectUnconfirmed(app, 'dirty-node');
        await runSuccess(app, 'dirty-node'); await expectDirty(app, 'dirty-node', false);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='dirty-node')?.generationRevision?.dirty===false)");
        const baseline = (await saved(app)).nodes.find(node => node.id === 'dirty-node');
        assert.ok(typeof baseline.generationRevision.successFingerprint === 'string');
        await open(app, 'dirty-node');
        await app.evaluate("document.querySelector('#dirty-node-image-results [data-result-step=\"-1\"]').click();document.querySelector('#image-parameter-panel .image-parameter-settings-entry').click();document.getElementById('btn-prompt-agent').click();document.querySelector('[data-parameter-action=front-parameters]').click();document.querySelector('[data-parameter-action=front-agent]').click();document.getElementById('btn-close-prompt-agent').click();document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('note').click()");
        await expectDirty(app, 'dirty-node', false);
        const startPoint = await app.evaluate("(()=>{const rect=document.querySelector('#dirty-node-image-results .image-node-result-preview').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...startPoint, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startPoint.x + 40, y: startPoint.y + 25, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startPoint.x + 40, y: startPoint.y + 25, button: 'left', buttons: 0, clickCount: 1 });
        await app.waitFor("parseFloat(document.getElementById('dirty-node').style.left)>80");
        await expectDirty(app, 'dirty-node', false);
        await waitForAutosave(app);
        await reloadAppBrowser(app); await expectDirty(app, 'dirty-node', false);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'dirty-node').generationRevision.successFingerprint, baseline.generationRevision.successFingerprint);
        assert.equal(await app.evaluate('statusRequests.length'), 0);
        const edits = [
            ['dirty-node-prompt', 'dirty-node edited prompt', null],
            ['dirty-node-apiconfig', 'image-other', 'model'],
            ['dirty-node-provider', 'q', 'model'],
            ['dirty-node-quality', 'high', 'size']
        ];
        for (const [id, value, group] of edits) {
            await open(app, 'dirty-node', group); await change(app, id, value);
            assert.equal(await app.evaluate(`document.getElementById(${JSON.stringify(id)}).value`), value);
            await expectDirty(app, 'dirty-node', true);
            assert.ok(await app.evaluate("document.querySelector('#dirty-node-image-results img')?.naturalWidth>0"), 'editing retains the readable previous result without claiming it is current');
            await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('note').click()");
            await runSuccess(app, 'dirty-node'); await expectDirty(app, 'dirty-node', false);
        }
        assert.equal(await app.evaluate('statusRequests.at(-1).body.quality'), 'high');
        assert.equal(await app.evaluate('statusRequests.at(-1).body.model'), 'gpt-image-1.5');
        assert.equal(await app.evaluate('new URL(statusRequests.at(-1).url).origin'), 'https://other-controlled.test');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value?.nodes.find(node=>node.id==='dirty-node');return node?.apiConfigId==='image-other'&&node.providerId==='q'})");
        let record = (await saved(app)).nodes.find(node => node.id === 'dirty-node');
        assert.equal(record.apiConfigId, 'image-other'); assert.equal(record.providerId, 'q');
        await open(app, 'dirty-node'); await change(app, 'dirty-node-prompt', 'dirty-node pending after reopen');
        await expectDirty(app, 'dirty-node', true);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await waitForAutosave(app);
        await reloadAppBrowser(app); await expectDirty(app, 'dirty-node', true);
        assert.equal((await saved(app)).nodes.find(node => node.id === 'dirty-node').generationRevision.dirty, true);
        await app.evaluate("statusFailures['dirty-node']=1"); await start(app, 'dirty-node');
        await app.waitFor("document.getElementById('dirty-node-run-status').dataset.status==='completed'&&document.getElementById('btn-stop').disabled");
        assert.equal(await app.evaluate("document.getElementById('dirty-node-run-status').textContent"), '部分完成');
        await expectDirty(app, 'dirty-node', true);
        assert.equal(await app.evaluate("document.querySelectorAll('#dirty-node-image-results .image-node-result-preview img').length===1"), true, 'a partially successful batch remains readable and pending');
        await waitForAutosave(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='dirty-node')?.mediaAssetKeys?.length===1)");
        const partialKeys = (await saved(app)).nodes.find(node => node.id === 'dirty-node').mediaAssetKeys;
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click();statusFailures['dirty-node']=2"); await start(app, 'dirty-node');
        await app.waitFor("document.getElementById('dirty-node-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled");
        await expectDirty(app, 'dirty-node', true);
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click()");
        await expectSavedOutputCleared(app, 'dirty-node', [...baseline.mediaAssetKeys, ...partialKeys]);
        await runSuccess(app, 'dirty-node'); await expectDirty(app, 'dirty-node', false);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='dirty-node')?.generationRevision?.dirty===false)");
        record = (await saved(app)).nodes.find(node => node.id === 'dirty-node');
        const legacy = { ...record }; delete legacy.generationRevision;
        const count = await app.evaluate('statusRequests.length');
        assert.equal(await app.evaluate(`fetch('/api/workflows/Legacy%20status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ workflowId: 'legacy-status-recipe', nodes: [legacy], connections: [] })})}).then(response=>response.ok)`), true);
        await activate(app, 'Legacy status');
        await expectUnconfirmed(app, 'dirty-node');
        await app.waitFor("document.querySelector('#dirty-node-image-results img')?.naturalWidth>0");
        const restoredLegacy = (await saved(app)).nodes.find(node => node.id === 'dirty-node');
        assert.ok(!restoredLegacy.generationRevision?.successFingerprint, 'loading a real old image does not invent its historical generation configuration');
        assert.deepEqual(restoredLegacy.mediaAssetKeys, record.mediaAssetKeys);
        assert.equal(await app.evaluate('statusRequests.length'), count);
    });
});

test('automatic retry clears the failed attempt and stale result before its held response, while top Stop preserves the pending generation marker', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...configuration, autoRetry: true, maxRetries: 1, nodes: [node('retry-node', 100, 120)], connections: [] }, async app => {
        await controlled(app); await start(app, 'retry-node'); await completed(app, 'retry-node');
        await app.waitFor("document.querySelector('#retry-node-image-results img')?.naturalWidth>0");
        await waitForAutosave(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='retry-node')?.mediaAssetKeys?.length===1)");
        const oldKeys = (await saved(app)).nodes.find(node => node.id === 'retry-node').mediaAssetKeys;
        await open(app, 'retry-node'); await change(app, 'retry-node-prompt', 'retry-node changed before retry');
        await expectDirty(app, 'retry-node', true);
        await app.evaluate("statusFailures['retry-node']=1;statusHold=['retry-node']"); await start(app, 'retry-node');
        await app.waitFor("statusRequests.some(request=>request.label==='retry-node'&&request.failed)&&document.getElementById('retry-node-run-status').textContent==='待运行'");
        assert.equal(await app.evaluate("document.getElementById('retry-node-image-results').hidden"), true);
        await expectSavedOutputCleared(app, 'retry-node', oldKeys);
        assert.equal(await app.evaluate("document.getElementById('retry-node-error').textContent"), '', 'the next retry clears its error before the backoff finishes');
        await app.waitFor("statusPending['retry-node']===true&&document.getElementById('retry-node-run-status').textContent==='运行中'");
        assert.equal(await app.evaluate("document.getElementById('retry-node-error').textContent"), '');
        assert.equal(await app.evaluate("document.querySelector('[data-node-id=retry-node] .node-failure-summary').classList.contains('hidden')"), true);
        assert.equal(await app.evaluate("document.querySelector('#retry-node .node-failure-indicator').classList.contains('hidden')"), true);
        assert.equal(await app.evaluate("document.getElementById('retry-node-image-results').hidden"), true);
        await expectSavedOutputCleared(app, 'retry-node', oldKeys);
        assert.doesNotMatch(await app.evaluate("document.getElementById('retry-node-generation-progress').textContent"), /\d+\s*%/);
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click();document.getElementById('btn-stop').focus({preventScroll:true})");
        await click(app, '#btn-stop');
        await app.waitFor("document.getElementById('btn-stop').disabled&&document.getElementById('retry-node-run-status').textContent==='已取消'");
        await expectDirty(app, 'retry-node', true);
        assert.equal(await app.evaluate("document.getElementById('retry-node-image-results').hidden"), true);
        await expectSavedOutputCleared(app, 'retry-node', oldKeys);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        await expectDirty(app, 'retry-node', true);
        await start(app, 'retry-node'); await completed(app, 'retry-node');
        await expectDirty(app, 'retry-node', false);
    });
});

test('reference order and replacing original bytes mark the effective recipe pending without destroying its previous image', { timeout: 90000 }, async () => {
    const edges = ['first', 'second'].map((id, index) => ({ id: `${id}-reference`, from: { nodeId: id, port: 'image' }, to: { nodeId: 'ref-target', port: 'referenceImages' }, type: 'image', order: index }));
    await withAppBrowser({ ...configuration, nodes: [node('ref-target', 500, 120), ...['first', 'second', 'replacement'].map((id, index) => ({ id, type: 'ImageImport', x: 30, y: 120 + index * 300 }))], connections: edges }, async app => {
        await controlled(app);
        await upload(app, 'first', 0); await upload(app, 'second', 1); await upload(app, 'replacement', 2);
        await runSuccess(app, 'ref-target', true); await expectDirty(app, 'ref-target', false);
        const originalAssets = (await saved(app)).nodes.filter(node => ['first', 'second', 'replacement'].includes(node.id)).map(node => [node.id, node.mediaAssetKeys]);
        assert.deepEqual(await app.evaluate("statusRequests.at(-1).body.references"), images.slice(0, 2).map(image => image.split(',')[1]));
        const pending = async () => {
            await expectDirty(app, 'ref-target', true);
            assert.ok(await app.evaluate("document.querySelector('#ref-target-image-results img')?.naturalWidth>0"), 'relationship edits retain the readable previous result');
        };
        await open(app, 'ref-target', 'reference');
        await app.evaluate("document.querySelector('[data-reference-connection=second-reference] .image-reference-thumbnail').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}))");
        await pending();
        await runSuccess(app, 'ref-target', true); await expectDirty(app, 'ref-target', false);
        assert.deepEqual(await app.evaluate("statusRequests.at(-1).body.references"), [images[1], images[0]].map(image => image.split(',')[1]));
        assert.deepEqual((await saved(app)).nodes.filter(node => ['first', 'second', 'replacement'].includes(node.id)).map(node => [node.id, node.mediaAssetKeys]), originalAssets);
        const count = await app.evaluate('statusRequests.length');
        await upload(app, 'first', 2); await pending();
        assert.equal(await app.evaluate('statusRequests.length'), count, 'replacing original bytes does not start generation');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await waitForAutosave(app);
        await reloadAppBrowser(app); await expectDirty(app, 'ref-target', true);
        await runSuccess(app, 'ref-target', true); await expectDirty(app, 'ref-target', false);
    });
});

test('a held background run confirms only its own recipe while an identical node ID remains editable and clone reference permissions stay separate', { timeout: 90000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app);
        for (const [name, document] of [
            ['Status A', { workflowId: 'status-a', nodes: [node('shared', 50, 120)], connections: [] }],
            ['Status B', { workflowId: 'status-b', nodes: [node('shared', 50, 120, { prompt: 'shared B original' }), node('clone', 500, 120, { isClone: true, cloneSourceId: 'shared' }), { id: 'b-ref', type: 'ImageImport', x: 20, y: 500 }], connections: [{ id: 'clone-ref', from: { nodeId: 'b-ref', port: 'image' }, to: { nodeId: 'clone', port: 'referenceImages' }, type: 'image', order: 0 }] }]
        ]) assert.equal(await app.evaluate(`fetch('/api/workflows/${encodeURIComponent(name)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(document)})}).then(response=>response.ok)`), true);
        await activate(app, 'Status A'); await expectUnconfirmed(app, 'shared');
        await open(app, 'shared'); await change(app, 'shared-prompt', 'shared A pending'); await expectDirty(app, 'shared', true);
        await app.evaluate("statusHold=['shared']"); await start(app, 'shared');
        await app.waitFor("statusPending.shared===true&&document.getElementById('shared-run-status').textContent==='运行中'");
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').disabled"), true);
        await activate(app, 'Status B'); await open(app, 'shared'); await expectUnconfirmed(app, 'shared');
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').disabled"), false, 'the background workflow cannot lock a different node with the same ID');
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), 'shared B original');
        await change(app, 'shared-prompt', 'shared B edited during A'); await expectDirty(app, 'shared', true);
        await upload(app, 'b-ref', 1); await open(app, 'clone', 'reference');
        assert.equal(await app.evaluate("document.getElementById('clone-prompt').disabled"), true);
        assert.equal(await app.evaluate("document.querySelector('[data-reference-connection=clone-ref] .image-reference-drag').dataset.reorderDisabled"), 'false', 'an idle clone retains its own reference mutation permissions');
        await app.evaluate("statusHold=[];statusRelease.shared()");
        await app.waitFor("statusPending.shared===false&&document.getElementById('btn-stop').disabled");
        await expectDirty(app, 'shared', true);
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), 'shared B edited during A');
        assert.equal(await app.evaluate("document.getElementById('shared-image-results').hidden"), true, 'background output never appears on the active same-ID node');
        await activate(app, 'Status A'); await expectDirty(app, 'shared', false);
        await app.waitFor("document.querySelector('#shared-image-results img')?.naturalWidth>0");
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), 'shared A pending');
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').disabled"), false);
        const graphA = await saved(app);
        assert.equal(graphA.nodes.find(node => node.id === 'shared').generationRevision.dirty, false);
        assert.equal(graphA.nodes.find(node => node.id === 'shared').mediaAssetKeys.length, 1);
        await activate(app, 'Status B'); await waitForAutosave(app);
        await waitForAutosave(app);
        await reloadAppBrowser(app); await expectDirty(app, 'shared', true);
        assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), 'shared B edited during A');
        assert.equal(await app.evaluate("document.getElementById('shared-image-results').hidden"), true);
    });
});
