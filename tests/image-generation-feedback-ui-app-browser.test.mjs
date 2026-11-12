import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';

const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '当前图片模型', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const generate = (id, x, y, width = 300) => ({ id, type: 'ImageGenerate', x, y, width, height: 220, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: id });
const failure = '测试失败：' + 'unbroken-error-token'.repeat(160) + '\n完整错误尾标：保留所有排查细节';

async function controlled(app, held = false) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.feedbackRequests=[];window.feedbackAborted=false;window.feedbackSuccess=false;const feedbackFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){feedbackRequests.push(body);const success=()=>new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}),{headers:{'Content-Type':'application/json'}});if(feedbackSuccess)return success();if(${held})return await new Promise((resolve,reject)=>{window.releaseFeedback=()=>resolve(success());options.signal.addEventListener('abort',()=>{feedbackAborted=true;reject(new DOMException('The operation was aborted','AbortError'))},{once:true})});return new Response(JSON.stringify({error:{message:${JSON.stringify(failure)}}}),{status:400,headers:{'Content-Type':'application/json'}});}}return feedbackFetch(url,options)};` });
    await reloadAppBrowser(app);
}

async function open(app, id) {
    await app.evaluate(`document.querySelectorAll('.notice-close').forEach(button=>button.click());document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
}

async function press(app, selector, milliseconds = 0) {
    const position = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    const hit = await app.evaluate(`(()=>{const target=document.elementFromPoint(${position.x},${position.y});return {reachable:document.querySelector(${JSON.stringify(selector)}).contains(target),target:target?.outerHTML.slice(0,250),position:${JSON.stringify(position)}}})()`);
    assert.equal(hit.reachable, true, `the real control is reachable: ${selector} ${JSON.stringify(hit)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    if (milliseconds) await delay(milliseconds);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}

test('failure feedback appears once in parameters and preserves complete modal details at normal and narrow widths', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [generate('failed', 40, 40, 260)], connections: [] }, async app => {
        await controlled(app); await open(app, 'failed');
        await app.evaluate("document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("document.getElementById('failed-run-status')?.dataset.status==='error'&&document.getElementById('btn-stop').disabled");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await app.waitFor("document.querySelector('.image-parameter-run-feedback').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')");
        assert.equal(await app.evaluate("!!document.querySelector('#failed > .image-first-run-feedback')"), false);
        const compact = await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),row=panel.querySelector('.image-parameter-run-feedback'),summary=row.querySelector('.node-failure-summary');return {inPanel:panel.contains(row),summary:summary.textContent,width:summary.clientWidth,scrollWidth:summary.scrollWidth,height:summary.getBoundingClientRect().height}})()");
        assert.ok(compact.inPanel);
        const errorStyle = await app.evaluate("(()=>{const row=document.querySelector('#image-parameter-panel .image-parameter-run-feedback'),style=getComputedStyle(row);return {background:style.backgroundColor,border:style.borderTopWidth,color:getComputedStyle(row.querySelector('.node-failure-summary')).color,ordinary:getComputedStyle(document.getElementById('image-parameter-panel')).color,icon:getComputedStyle(row,'::before').content}})()");
        assert.notEqual(errorStyle.background, 'rgba(0, 0, 0, 0)', 'errors have a tinted surface');
        assert.equal(errorStyle.border, '1px');
        assert.notEqual(errorStyle.color, errorStyle.ordinary, 'error text retains its semantic color outside the canvas');
        assert.equal(errorStyle.icon, '\"!\"');
        assert.equal(await app.evaluate("document.getElementById('failed-error').checkVisibility()"), false, 'only the concise failure and detail entry are shown');
        assert.ok(compact.summary.length < 200 && compact.summary.includes('测试失败'));
        assert.ok(compact.scrollWidth <= compact.width + 1 && compact.height <= 48);
        if (await app.evaluate("document.getElementById('modal-error').classList.contains('active')")) {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
            await app.waitFor("!document.getElementById('modal-error').classList.contains('active')");
        }
        await press(app, '#image-parameter-panel [data-image-run-action=details]');
        await app.waitFor("document.getElementById('modal-error').classList.contains('active')");
        await app.evaluate("if(!document.getElementById('btn-show-full-log').classList.contains('hidden'))document.getElementById('btn-show-full-log').click()");
        assert.match(await app.evaluate("document.getElementById('error-modal-detail').textContent+document.getElementById('error-modal-msg').textContent"), /完整错误尾标：保留所有排查细节/);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.getElementById('modal-error').classList.contains('active')");
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 500, deviceScaleFactor: 1, mobile: false });
        await open(app, 'failed');
        assert.equal(await app.evaluate("document.getElementById('failed-error').checkVisibility()"), false, 'the legacy full error must not duplicate the summary');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .node-failure-summary').checkVisibility()"), true);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-image-run-action=details]').click()");
        await app.waitFor("document.getElementById('modal-error').classList.contains('active')");
        await app.evaluate("if(!document.getElementById('btn-show-full-log').classList.contains('hidden'))document.getElementById('btn-show-full-log').click()");
        assert.match(await app.evaluate("document.getElementById('error-modal-detail').textContent+document.getElementById('error-modal-msg').textContent"), /完整错误尾标：保留所有排查细节/);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.getElementById('modal-error').classList.contains('active')");
        await app.evaluate("feedbackSuccess=true;document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("document.getElementById('failed-run-status').dataset.status==='completed'");
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#image-parameter-panel .image-parameter-run-feedback'),'::before').content"), 'none', 'success clears the error icon');
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#image-parameter-panel .image-parameter-run-feedback')).borderTopWidth"), '0px', 'success clears the error border');
    });
});

test('successful status never covers the original result operations or the parameter editor', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [generate('success', 40, 40, 420)], connections: [] }, async app => {
        await controlled(app); await open(app, 'success');
        await app.evaluate("feedbackSuccess=true;document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("document.getElementById('success-run-status')?.dataset.status==='completed'&&document.querySelector('#success [data-result-action=reference]')");
        await app.waitFor("document.querySelector('#success .image-node-result-preview img')?.naturalWidth>0");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().top>=document.querySelector('#success .image-result-actions').getBoundingClientRect().bottom");
        await app.waitFor("(()=>{const el=document.querySelector('#success [data-result-action=reference]'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()");
        const referenceAction = await app.evaluate(`(()=>{
            const button=document.querySelector('#success [data-result-action=reference]');
            const rect=button.getBoundingClientRect();
            const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
            return {reachable:button.contains(hit),hit:hit?.outerHTML.slice(0,400),
                panel:document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON(),button:rect.toJSON()};
        })()`);
        assert.ok(referenceAction.reachable, JSON.stringify(referenceAction));
        const geometry = await app.evaluate("(()=>{const node=document.getElementById('success'),actions=node.querySelector('.image-result-actions').getBoundingClientRect(),panel=document.getElementById('image-parameter-panel').getBoundingClientRect(),preview=node.querySelector('.image-node-result-preview');return {nodeWidth:node.clientWidth,previewWidth:preview.clientWidth,fit:getComputedStyle(preview.querySelector('img')).objectFit,nodeBottom:node.getBoundingClientRect().bottom,actionsTop:actions.top,actionsBottom:actions.bottom,panelTop:panel.top,font:parseFloat(getComputedStyle(document.getElementById('success-run-status')).fontSize)}})()");
        assert.ok(geometry.actionsTop >= geometry.nodeBottom + 4 && geometry.panelTop >= geometry.actionsBottom, JSON.stringify(geometry));
        assert.ok(geometry.previewWidth >= geometry.nodeWidth - 20, 'generated media uses the card width with a narrow gutter');
        assert.equal(geometry.fit, 'contain', 'the complete image remains visible');
        assert.ok(geometry.font >= 13);
    });
});

test('a genuinely incomplete batch says partially completed with its real progress and original failure details, then a complete attempt clears that presentation', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ ...generate('partial', 40, 180, 420), generationCount: 2 }], connections: [] }, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.partialRequests=0;window.partialFail=true;const partialFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){partialRequests++;if(partialFail&&partialRequests===1)return new Response(JSON.stringify({error:{message:'partial-provider-failure-detail'}}),{status:400,headers:{'Content-Type':'application/json'}});return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}),{headers:{'Content-Type':'application/json'}});}}return partialFetch(url,options)};" });
        await reloadAppBrowser(app); await open(app, 'partial');
        await app.evaluate("const prompt=document.getElementById('partial-prompt');prompt.value='partial edited pending prompt';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("partialRequests===2&&document.getElementById('partial-run-status').dataset.status==='completed'&&document.getElementById('btn-stop').disabled");
        assert.equal(await app.evaluate("document.getElementById('partial-run-status').textContent"), '部分完成');
        assert.equal(await app.evaluate("document.getElementById('partial-generation-progress').textContent"), '1/2');
        assert.equal(await app.evaluate("document.getElementById('partial-generation-progress').checkVisibility()"), true, await app.evaluate("document.getElementById('partial-generation-progress').parentElement.outerHTML"));
        assert.equal(await app.evaluate("!document.querySelector('[data-node-id=partial] [data-image-generation-dirty]')"), true);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='partial')?.generationRevision?.dirty===true)");
        await app.evaluate("document.querySelector('[data-parameter-action=close]').click()");
        await press(app, '#partial .node-concurrent-status-dot[data-status=failed]');
        assert.match(await app.evaluate("document.querySelector('.node-concurrent-status-error-popover:not(.hidden)').textContent"), /partial-provider-failure-detail/);
        await open(app, 'partial');
        await app.evaluate("partialFail=false;document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("partialRequests===4&&document.getElementById('partial-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        assert.equal(await app.evaluate("document.getElementById('partial-generation-progress').textContent"), '2/2');
        assert.equal(await app.evaluate("document.getElementById('partial-generation-progress').checkVisibility()"), true);
        assert.equal(await app.evaluate("!document.querySelector('[data-node-id=partial] [data-image-generation-dirty]')"), true);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='partial')?.generationRevision?.dirty===false)");
        assert.equal(await app.evaluate("document.querySelector('#partial .node-concurrent-status-dot[data-status=failed]')===null"), true);
    });
});

test('the parameter panel tracks individual images and retries just the failed slot without replacing or reordering successful results', { timeout: 45000 }, async () => {
    const id = 'batch-retry';
    const originals = await Promise.all(['red', 'green', 'blue'].map(color => readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))));
    const hashes = originals.map(image => createHash('sha256').update(image).digest('hex'));
    const initScript = `
        const originalFetch = window.fetch.bind(window);
        const images = ${JSON.stringify(originals.map(image => image.toString('base64')))};
        window.imageBatchRequests = [];
        window.releaseImageBatchRequest = [];
        window.fetch = async (url, options = {}) => {
            if (String(url) !== '/proxy' || typeof options.body !== 'string') return originalFetch(url, options);
            const request = JSON.parse(options.body);
            if (request.prompt !== ${JSON.stringify(id)}) return originalFetch(url, options);
            const index = imageBatchRequests.push(request) - 1;
            return new Promise((resolve, reject) => {
                const onAbort = () => reject(options.signal.reason);
                options.signal?.addEventListener('abort', onAbort, { once: true });
                releaseImageBatchRequest[index] = imageIndex => {
                    options.signal?.removeEventListener('abort', onAbort);
                    resolve(imageIndex < 0
                        ? Response.json({ error: { message: 'fixture failure for image 2' } }, { status: 400 })
                        : Response.json({ data: [{ b64_json: images[imageIndex] }] }));
                };
            });
        };`;
    const panel = '#image-parameter-panel';
    const section = `${panel} .image-generation-batch`;
    const failedSlot = `${section} [data-image-batch-slot="1"]`;
    const retry = `${failedSlot} [data-image-batch-retry]`;
    const preview = `${failedSlot} [data-image-batch-preview]`;
    const rows = `Array.from(document.querySelectorAll('${section} [data-image-batch-slot]'))`;
    const statuses = `${rows}.map(row=>row.dataset.status)`;
    const assetKeys = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(document=>document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys || [])`;
    const waitForStates = (app, expected) => app.waitFor(`JSON.stringify(${statuses})===${JSON.stringify(JSON.stringify(expected))}`);

    await withAppBrowser({ ...configuration, concurrentRequestMode: true, nodes: [{ ...generate(id, 40, 80, 320), generationCount: 3 }], connections: [] }, async app => {
        await open(app, id);
        await app.evaluate(`document.querySelector('${panel} [data-parameter-action=generate]').click()`);
        await app.waitFor('releaseImageBatchRequest.length===3');
        await waitForStates(app, ['running', 'running', 'running']);
        assert.deepEqual(await app.evaluate(`${rows}.map(row=>row.dataset.imageBatchSlot)`), ['0', '1', '2']);

        await app.evaluate('releaseImageBatchRequest[2](2);releaseImageBatchRequest[1](-1)');
        await waitForStates(app, ['running', 'failed', 'completed']);
        assert.equal(await app.evaluate(`(()=>{const preview=document.querySelector('${section} [data-image-batch-slot="2"] [data-image-batch-preview]');return preview.checkVisibility()&&!preview.disabled})()`), true, 'completed images can be previewed while other slots run');
        assert.equal(await app.evaluate(`document.querySelector('${retry}')?.checkVisibility() === true && document.querySelector('${retry}').disabled`), true);
        const error = `${failedSlot} details`;
        await app.evaluate(`document.querySelector('${error} summary').click()`);
        assert.match(await app.evaluate(`document.querySelector('${error}[open] p')?.innerText`), /fixture failure for image 2/);
        await app.evaluate(`document.querySelector('${error} summary').click()`);

        await app.evaluate('releaseImageBatchRequest[0](0)');
        await waitForStates(app, ['completed', 'failed', 'completed']);
        await app.waitFor(`document.querySelector('${retry}')?.disabled===false&&(${assetKeys}).then(keys=>keys.length===2)`);
        const successes = await app.evaluate(assetKeys);

        await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 680, deviceScaleFactor: 1, mobile: false });
        await open(app, id);
        await app.evaluate(`document.querySelector('${retry}').scrollIntoView({block:'nearest'})`);
        assert.equal(await app.evaluate(`(()=>{const section=document.querySelector('${section}');return section.scrollWidth<=section.clientWidth+1})()`), true, 'individual status rows fit the narrow panel');
        await app.waitFor(`document.getElementById('toast-container').getBoundingClientRect().bottom<=document.querySelector('${panel}').getBoundingClientRect().top`, 1000);
        await press(app, retry);
        await app.waitFor('releaseImageBatchRequest.length===4');
        await waitForStates(app, ['completed', 'running', 'completed']);
        assert.equal(await app.evaluate('imageBatchRequests.length'), 4, 'retrying the middle image sends only one more provider request');

        await app.evaluate('releaseImageBatchRequest[3](1)');
        await waitForStates(app, ['completed', 'completed', 'completed']);
        await app.waitFor(`(${assetKeys}).then(keys=>keys.length===3)`);
        const saved = await app.evaluate(assetKeys);
        assert.deepEqual([saved[0], saved[2]], successes, 'retry preserves the identities of the two already-saved images');
        const savedHashes = await app.evaluate(`Promise.all(${JSON.stringify(saved)}.map(async key=>{
            const response=await fetch('/api/storage/assets/'+encodeURIComponent(key));
            const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
            return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
        }))`);
        assert.deepEqual(savedHashes, hashes, 'all three original files remain in slot order after a partial retry');
        assert.equal(await app.evaluate('imageBatchRequests.length'), 4);
        await app.waitFor(`document.querySelector('${preview} img')?.naturalWidth>0`);
        await app.evaluate(`document.querySelector('${preview}').scrollIntoView({block:'nearest'})`);
        await press(app, preview);
        await app.waitFor("document.querySelector('.fullscreen-img-wrapper > img')?.naturalWidth>0");
        assert.equal(await app.evaluate(`document.querySelector('.fullscreen-img-wrapper > img').src===document.querySelector('${preview} img').src`), true);
    }, { initScript });
});

test('waiting has no fabricated progress and the original reachable two-second cancel still protects a held upstream run outside locked parameters', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [generate('upstream', 40, 80), generate('target', 600, 80)], connections: [
        { id: 'reference-edge', from: { nodeId: 'upstream', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0 }
    ] }, async app => {
        await controlled(app, true); await open(app, 'target');
        // Running upstream is explicit; the parameter button only reuses its cache.
        await app.evaluate("document.querySelector('[data-parameter-group-toggle=more]').click();document.getElementById('target').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("feedbackRequests.length===1&&document.getElementById('target-run-status')?.dataset.status==='waiting'");
        assert.equal(await app.evaluate("document.getElementById('target-generation-progress').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.querySelector('[data-parameter-action=generate]').disabled"), true);
        assert.equal(await app.evaluate("(()=>{const controls=[...document.querySelectorAll('.image-reference-overview .image-reference-drag')];return controls.length>0&&controls.every(control=>control.dataset.reorderDisabled==='true')})()"), true);
        assert.equal(await app.evaluate("document.querySelector('#upstream .node-run-cancel-btn').closest('fieldset[disabled]')===null"), true);
        await press(app, '#upstream .node-run-cancel-btn', 150);
        await delay(350);
        assert.equal(await app.evaluate('feedbackAborted'), false, 'a normal click never cancels the request');
        await open(app, 'upstream');
        const cancelPoint = await point(app, '#upstream .node-run-cancel-btn');
        assert.equal(await app.evaluate(`document.querySelector('#upstream .node-run-cancel-btn').contains(document.elementFromPoint(${cancelPoint.x},${cancelPoint.y}))`), true, 'the selected running node keeps its original cancel reachable above its parameter editor');
        await press(app, '#upstream .node-run-cancel-btn', 2150);
        await app.waitFor("feedbackAborted&&document.getElementById('upstream-run-status')?.dataset.status==='aborted'&&document.getElementById('btn-stop').disabled");
        await app.waitFor("document.querySelector('#image-parameter-panel .image-generation-batch [data-image-batch-slot=\"0\"][data-status=cancelled]')?.checkVisibility()");
        assert.equal(await app.evaluate("document.querySelector('#upstream .node-run-cancel-btn').checkVisibility()"), false);
        assert.equal(await app.evaluate("['upstream','target'].every(id=>document.getElementById(id))&&[...document.querySelectorAll('#nodes-layer>.node')].filter(node=>!['upstream','target'].includes(node.id)).every(node=>node.classList.contains('node-save'))"), true);
    });
});
