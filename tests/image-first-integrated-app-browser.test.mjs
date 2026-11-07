import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { configuration, imageTypes, originals, graphEdge, integratedWorkflow, saved, recordPlayableVideo,
    controlProviders, upload, openParameters as openBaseParameters, runNode, nativeClick, key, persist } from './helpers/image-first-integrated-fixture.mjs';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];
const screenshotDirectory = process.env.CAINFLOW_QA_SCREENSHOT_DIR || 'D:/mygithub/CainFlow/.scratch/image-first-canvas/verification/themes';
const panel = '#image-parameter-panel';
const geometry = app => app.evaluate("({canvas:document.getElementById('nodes-layer').style.transform,nodes:[...document.querySelectorAll('#nodes-layer>.image-first-card')].map(node=>({id:node.id,x:node.style.left,y:node.style.top,width:node.offsetWidth,height:node.offsetHeight})),ports:[...document.querySelectorAll('#nodes-layer .image-first-card .node-port')].filter(port=>port.checkVisibility()).map(port=>({nodeId:port.closest('.node').id,port:port.dataset.port,direction:port.dataset.direction,rect:port.querySelector('.port-dot').getBoundingClientRect().toJSON()}))})");
const getKeys = (graph, id) => graph.nodes.find(node => node.id === id)?.mediaAssetKeys || [];

async function openParameters(app, id, group = null) {
    await openBaseParameters(app, id, group === 'reference' ? null : group);
}

async function clickVisibleSurface(app, id) {
    const position = await app.evaluate(`(()=>{const root=document.getElementById(${JSON.stringify(id)}),r=root.getBoundingClientRect();for(const y of [r.top+20,r.top+r.height/2,r.bottom-10])for(const x of [r.left+4,r.right-4,r.left+r.width/2]){const hit=document.elementFromPoint(x,y);if(root.contains(hit)&&!hit.closest('button,input,textarea,select,[role=separator]'))return {x,y}}return null})()`);
    assert.ok(position, `a visible part of ${id} is reachable`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}

async function capture(app, name, manifest = null) {
    await mkdir(screenshotDirectory, { recursive: true });
    await app.evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    if (manifest) assert.ok(await app.evaluate("(()=>{const rect=document.getElementById('image-parameter-panel').getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1})()"), 'manual navigation places the complete editor width in the screenshot');
    const shot = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(shot.data, 'base64'));
    if (manifest) manifest.push({ name, ...await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),r=p.getBoundingClientRect();return {theme:document.documentElement.dataset.appTheme,viewport:[innerWidth,innerHeight],zoom:document.getElementById('zoom-level').textContent,panel:r.toJSON(),mode:p.dataset.mode,selected:document.getElementById('generate').classList.contains('selected'),status:document.getElementById('generate-run-status').dataset.status,failure:document.getElementById('failure-run-status').dataset.status,disabled:document.getElementById('disabled').classList.contains('disabled'),references:[...document.querySelectorAll('#generate-reference-sources [data-reference-number]')].map(element=>element.dataset.referenceNumber),focus:document.activeElement?.outerHTML.slice(0,200),colors:{text:getComputedStyle(p).color,surface:getComputedStyle(p).backgroundImage,focus:getComputedStyle(document.activeElement).outlineColor}}})()") });
}

async function resizeViewport(app, width, height) {
    await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

async function zoom(app, value) {
    await app.evaluate(`document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom="${value}"]').click()`);
    await app.waitFor(`document.getElementById('zoom-level').textContent===${JSON.stringify(Number(value) * 100 + '%')}`);
}

async function panPanelTo(app, top, left = null) {
    for (let attempt = 0; attempt < 18; attempt++) {
        const rect = await app.evaluate("document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON()");
        const remaining = top - rect.top, horizontal = left === null ? 0 : left - rect.left;
        if (Math.abs(remaining) < 2 && Math.abs(horizontal)<2) return;
        const distance = Math.max(-90, Math.min(90, remaining));
        const dx = Math.max(-90, Math.min(90, horizontal));
        const origin = await app.evaluate("(()=>{for(const x of [4,innerWidth-4])for(const y of [500,550,350,300,260,650,750]){const hit=document.elementFromPoint(x,y);if(hit?.closest('#canvas-container')&&!hit.closest('.node,#image-parameter-panel,#canvas-navigation'))return {x,y}}return null})()");
        assert.ok(origin, 'manual navigation starts on actual blank canvas');
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...origin });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...origin, button: 'middle', buttons: 4, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: origin.x + dx, y: origin.y + distance, button: 'middle', buttons: 4 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: origin.x + dx, y: origin.y + distance, button: 'middle', buttons: 0, clickCount: 1 });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
    assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&p.top>=0&&p.bottom<=innerHeight})()"),'manual panning keeps the editor visible');
}

async function focusTool(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').focus({preventScroll:true})");
    await key(app, 'Tab', 'Tab'); await key(app, 'Tab', 'Tab', 8);
    assert.ok(await app.evaluate("(()=>{const control=document.activeElement;return !!control.closest('#image-parameter-panel')&&control.matches(':focus-visible')&&getComputedStyle(control).outlineStyle!=='none'})()"), 'keyboard focus has an actual visible indicator');
}

async function checkPanel(app) {
    assert.ok(await app.evaluate("[...document.querySelectorAll('#nodes-layer > .image-first-card')].every(node=>{const glass=node.querySelector(':scope > .node-glass-bg');return getComputedStyle(node).backgroundColor!=='rgba(0, 0, 0, 0)'||(glass&&getComputedStyle(glass).backgroundColor!=='rgba(0, 0, 0, 0)')})"),
        'borderless image nodes retain their theme background instead of becoming transparent');
    assert.ok(await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node')].every(node=>{const s=getComputedStyle(node),glass=node.querySelector(':scope > .node-glass-bg');return s.borderTopColor==='rgba(0, 0, 0, 0)'&&(!glass||getComputedStyle(glass).borderTopStyle==='none')})"),
        'all canvas nodes remain free of decorative borders in each live theme');
    assert.ok(await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),scroll=panel.querySelector('.image-parameter-scroll'),input=document.getElementById('generate-prompt');return scroll.scrollWidth<=scroll.clientWidth+1&&parseFloat(getComputedStyle(input).fontSize)>=13&&input===window.integrationOriginalPrompt})()"), 'the original form stays readable and does not overflow horizontally');
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#generate-reference-sources [data-reference-number]')].map(element=>element.dataset.referenceNumber)"), ['1', '2', '3', '4', '5']);
    assert.equal(await app.evaluate("document.querySelector('[data-reference-connection=disabled-reference]').dataset.enabled"), 'false');
}

async function checkOverlap(app, owner) {
    await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().right <= document.getElementById('prompt-agent-panel').getBoundingClientRect().left-8");
    assert.ok(await app.evaluate(`(()=>{const p=document.getElementById(${JSON.stringify(owner)}),r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`), 'both separate surfaces remain reachable');
}

async function assetFacts(app, key) {
    return app.evaluate(`(async()=>{const response=await fetch('/api/storage/assets/'+encodeURIComponent(${JSON.stringify(key)}));if(!response.ok)throw new Error('Original asset is unavailable');const blob=await response.blob(),bytes=await blob.arrayBuffer(),bitmap=await createImageBitmap(blob);return {width:bitmap.width,height:bitmap.height,mime:blob.type,bytes:blob.size,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')}})()`);
}

test('nine image node types coexist with live Text, Params and Video through a complete shared-media workflow and reopening', { timeout: 90000 }, async () => {
    const workflow = integratedWorkflow();
    await withAppBrowser(workflow, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1200, deviceScaleFactor: 1, mobile: false });
        const video = await recordPlayableVideo(app);
        await controlProviders(app, { video }); await upload(app);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#nodes-layer>.image-first-card')].map(node=>node.id).sort()"), workflow.nodes.filter(node=>imageTypes.includes(node.type)).map(node=>node.id).sort());
        const initial = await geometry(app);
        const originalSource = getKeys(await saved(app), 'source');
        for (const node of workflow.nodes.filter(node => imageTypes.includes(node.type))) {
            await openParameters(app, node.id);
            const ports = await app.evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(node.id)});return {inputs:[...node.querySelectorAll('.node-port[data-direction=input]')].filter(port=>port.checkVisibility()).map(port=>port.dataset.port),outputs:[...node.querySelectorAll('.node-port[data-direction=output]')].filter(port=>port.checkVisibility()).map(port=>port.dataset.port),panels:document.querySelectorAll('#image-parameter-panel').length}})()`);
            assert.deepEqual(ports.inputs, node.type === 'ImageImport' ? [] : ['auto'], `${node.type} exposes exactly its universal display input`);
            assert.deepEqual(ports.outputs, node.type === 'ImageSave' ? ['image', 'video'] : node.type === 'CameraControl' ? ['text'] : ['image']);
            assert.equal(ports.panels, 1);
            await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
            assert.deepEqual(await geometry(app), initial, 'mounting each original form cannot move the canvas, cards, ports or existing edges');
        }
        await openParameters(app, 'resize');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('resize-target-width'))"), true);
        assert.equal(await app.evaluate("document.getElementById('resize-target-width').value"), '384');
        await openParameters(app, 'generate', 'reference');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#generate-reference-sources .image-reference-group')].map(row=>row.dataset.referenceConnection)"), ['source-reference','color-reference']);
        assert.match(await app.evaluate("document.getElementById('generate-prompt-source').textContent"), /integrated upstream prompt/);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('text').click();document.getElementById('btn-run').click()");
        await app.waitFor("integrationRequests.filter(request=>request.kind==='image').length===3&&document.getElementById('btn-stop').disabled");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='save')?.mediaAssetKeys?.length===5&&document.value.nodes.find(node=>node.id==='save')?.videos?.length===1)");
        const generated = await persist(app);
        assert.deepEqual(generated.connections, workflow.connections, 'logical roles, sparse numeric inputs, edge IDs, endpoint extensions and explicit order survive the complete run');
        assert.deepEqual(getKeys(generated, 'source'), originalSource);
        assert.equal(getKeys(generated, 'generate').length, 3);
        const merged = [...getKeys(generated, 'compare'), ...originalSource, ...getKeys(generated, 'generate')];
        for (const id of ['merge', 'preview', 'save']) assert.deepEqual(getKeys(generated, id), merged, `${id} receives the complete numeric-slot ordered batch`);
        const request = await app.evaluate("integrationRequests.find(request=>request.kind==='image').body");
        assert.ok(request.prompt.includes('integrated upstream prompt'));
        assert.ok(request.prompt.includes(generated.nodes.find(node => node.id === 'camera').cameraPrompt));
        assert.ok(!request.prompt.includes('retained local draft'));
        assert.equal(request.quality, 'high'); assert.equal(request.references, 2);
        const resized = await assetFacts(app, getKeys(generated, 'resize')[0]);
        assert.deepEqual([resized.width, resized.height], [384, 256]);
        assert.equal((await assetFacts(app, originalSource[0])).width, 1024);
        await app.waitFor("document.querySelector('#save-save-preview .image-save-video-pane video')?.readyState>=2");
        const player = await app.evaluate("(()=>{const video=document.querySelector('#save-save-preview video');return {controls:video.controls,width:video.videoWidth,height:video.videoHeight,key:document.getElementById('save-save-preview').dataset.videoAssetKey}})()");
        assert.deepEqual([player.controls, player.width, player.height], [true, 96, 64]);
        assert.equal(generated.nodes.find(node => node.id === 'save').videos[0].assetKey, video.key);
        await capture(app, 'integrated-workflow');
        await openParameters(app, 'generate');
        await nativeClick(app, '#generate .image-node-result-preview', { count: 2 });
        await app.waitFor("document.querySelector('.fullscreen-overlay img')?.naturalWidth===1024");
        const fullscreen = await app.evaluate("document.querySelector('.fullscreen-overlay img').src");
        assert.ok(originals.includes(fullscreen), 'the read action opens a provider original, not a reduced thumbnail');
        await key(app, 'Escape');
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        const completedGeometry = await geometry(app);
        await persist(app); await reloadAppBrowser(app);
        const reopened = await saved(app);
        assert.deepEqual(reopened.connections, workflow.connections);
        for (const id of ['source', 'resize', 'color', 'generate', 'compare', 'merge', 'preview', 'save']) assert.deepEqual(getKeys(reopened, id), getKeys(generated, id), `${id} restores the same original identities`);
        const restoredGeometry = await geometry(app);
        const anchors = snapshot => snapshot.nodes.map(({height, ...anchor})=>anchor);
        assert.deepEqual(anchors(restoredGeometry), anchors(completedGeometry), 'restoring lazy media retains every node position and width');
        assert.equal(restoredGeometry.canvas, completedGeometry.canvas);
        const ports = snapshot => snapshot.ports.map(({rect, ...identity})=>identity);
        assert.deepEqual(ports(restoredGeometry), ports(completedGeometry));
        assert.equal(await app.evaluate('integrationRequests.length'), 0, 'restoring the workflow does not execute any model');
        await openParameters(app, 'generate');
        assert.equal(await app.evaluate("document.getElementById('generate-prompt').value"), 'retained local draft');
        assert.deepEqual(reopened.nodes.find(node => node.id === 'params').params, [{ key: 'quality', value: 'high' }]);
    });
});

test('seven live themes preserve real run states, compact references, native focus and overlapping editors at normal and narrow fifty-percent zoom', { timeout: 180000 }, async () => {
    const workflow = integratedWorkflow();
    workflow.nodes = workflow.nodes.map(node => {
        if (node.id === 'generate') return { ...node, x: 70, y: 140, width: 340, apiConfigId: 'google', generationCount: 1 };
        if (node.id === 'text') return { ...node, text: 'RUN_HELD integrated upstream prompt', x: -700 };
        if (node.id === 'source') return { ...node, x: 600, y: 950, customTitle: '真实完整参考来源：保留长标题与原图身份', imageDescription: '完整参考说明可阅读，主题或面板改变不能丢失。\n'.repeat(8) };
        return { ...node, x: node.id === 'color' ? 600 : node.x + 1700, y: node.id === 'color' ? 610 : node.y };
    });
    workflow.nodes.push(
        { id: 'batch', type: 'ImageGenerate', x: 570, y: 140, width: 330, height: 260, userResized: true, customTitle: '三张真实完整参考批次', apiConfigId: 'image', providerId: 'p', prompt: 'three real references', generationCount: 3 },
        { id: 'failure', type: 'ImageGenerate', x: 1050, y: 140, width: 330, height: 260, userResized: true, customTitle: '失败摘要与详情', apiConfigId: 'image', providerId: 'p', prompt: 'FAIL_THEME' },
        { id: 'disabled', type: 'ImageImport', x: 1050, y: 610, width: 270, height: 230, userResized: true, customTitle: '已停用来源仍保留原图' }
    );
    workflow.connections.push(graphEdge('batch-reference', 'batch', 'image', 'generate', 'referenceImages', 'image', 12), graphEdge('disabled-reference', 'disabled', 'image', 'generate', 'referenceImages', 'image', 18));
    await withAppBrowser(workflow, async app => {
        await resizeViewport(app, 1600, 1000); await controlProviders(app);
        await upload(app); await upload(app, 'disabled', 1);
        await app.evaluate("document.querySelector('#disabled .node-bypass-btn').click()");
        await runNode(app, 'batch', true);
        await app.waitFor("document.getElementById('batch-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        await runNode(app, 'generate');
        await app.waitFor("document.getElementById('generate-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        await runNode(app, 'failure', true);
        await app.waitFor("document.getElementById('failure-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled");
        await key(app, 'Escape');
        await openParameters(app, 'generate', 'reference');
        await app.waitFor("document.querySelectorAll('#generate-reference-sources [data-reference-number]').length===5");
        await app.evaluate("window.integrationOriginalPrompt=document.getElementById('generate-prompt');integrationHold=true");
        await runNode(app, 'generate', true);
        await app.waitFor("integrationPending&&document.getElementById('generate-run-status').textContent==='运行中'");
        await openParameters(app, 'generate', 'reference');
        await app.waitFor("document.querySelectorAll('#toast-container .toast').length<=1");
        const baseline = await saved(app), originalKeys = getKeys(baseline, 'batch'), requests = await app.evaluate('integrationRequests.length');
        const manifest = [];
        for (const theme of themes) {
            await resizeViewport(app, 1600, 1000);
            await app.evaluate("document.getElementById('btn-theme-toggle').click()");
            await app.waitFor(`Boolean(document.querySelector('#theme-menu [data-theme-id=${theme}]'))`);
            await app.evaluate(`document.querySelector('#theme-menu [data-theme-id=${theme}]').click()`);
            await app.waitFor(`document.documentElement.dataset.appTheme===${JSON.stringify(theme)}`);
            if (await app.evaluate("document.getElementById('zoom-level').textContent!=='100%'")) await zoom(app, '1');
            await openParameters(app, 'generate', 'reference'); await panPanelTo(app, 380, 24);
            await app.evaluate("(()=>{const body=document.querySelector('#image-parameter-panel .image-parameter-scroll'),gallery=document.querySelector('#generate-reference-sources .image-reference-grid');body.scrollTop=0;gallery.scrollLeft=0})()");
            await checkPanel(app); await focusTool(app);
            assert.equal(await app.evaluate("document.getElementById('generate-prompt').disabled&&document.getElementById('disabled').classList.contains('disabled')&&document.getElementById('failure-run-status').textContent==='失败'"), true);
            await openParameters(app, 'failure');
            assert.equal(await app.evaluate("document.querySelector('[data-node-id=failure] [data-image-generation-dirty]')"), null, 'pending state adds no presentation row');
            await capture(app, `${theme}-normal-references`, manifest);
            const canvas = await app.evaluate("document.getElementById('nodes-layer').style.transform");
            await nativeClick(app, '[data-node-id=failure] [data-image-run-action=details]');
            await app.waitFor("document.getElementById('modal-error').classList.contains('active')");
            assert.ok(await app.evaluate("!!document.getElementById('image-parameter-panel').closest('[inert]')"), 'a real failure modal masks the parameter editor');
            await key(app, 'Escape');
            await app.waitFor("!document.getElementById('modal-error').classList.contains('active')");
            assert.ok(await app.evaluate("!!document.activeElement.closest('[data-node-id=failure]')"), 'Escape restores focus to the actual error opener');
            await openParameters(app, 'generate', 'reference');
            assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-references').checkVisibility()"));
            await focusTool(app); await checkPanel(app);
            assert.equal(await app.evaluate("document.getElementById('nodes-layer').style.transform"), canvas);
            await capture(app, `${theme}-expanded`, manifest);
            await app.evaluate("(()=>{document.getElementById('btn-prompt-agent').click();const input=document.getElementById('prompt-agent-input');input.value='明确保留的助手草稿与当前节点互不覆盖';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
            await clickVisibleSurface(app, 'prompt-agent-panel');
            await checkOverlap(app, 'prompt-agent-panel');
            await clickVisibleSurface(app, 'image-parameter-panel');
            await checkOverlap(app, 'image-parameter-panel');
            await clickVisibleSurface(app, 'prompt-agent-panel');
            await capture(app, `${theme}-agent-overlap`, manifest);
            assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), '明确保留的助手草稿与当前节点互不覆盖');
            await app.evaluate("document.getElementById('btn-prompt-agent').click()");
            await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
            const beforeNarrow = await app.evaluate("document.getElementById('nodes-layer').style.transform");
            await resizeViewport(app, 360, 420);
            assert.equal(await app.evaluate("document.getElementById('nodes-layer').style.transform"), beforeNarrow, 'viewport constraints cannot pan the canvas');
            await zoom(app, '0.5');
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            await checkPanel(app); await focusTool(app);
            await openParameters(app, 'generate', 'reference');
            await app.evaluate("(()=>{const body=document.querySelector('#image-parameter-panel .image-parameter-scroll'),gallery=document.querySelector('#generate-reference-sources .image-reference-grid');body.scrollTop+=gallery.getBoundingClientRect().top-body.getBoundingClientRect().top;gallery.scrollLeft=0})()");
            await capture(app, `${theme}-narrow-normal-50`, manifest);
            const scroll = await app.evaluate("(()=>{const gallery=document.querySelector('#generate-reference-sources .image-reference-grid'),body=document.querySelector('#image-parameter-panel .image-parameter-scroll');const rect=gallery.getBoundingClientRect(),clip=body.getBoundingClientRect(),x=Math.max(15,Math.min(innerWidth-15,rect.x+rect.width/2));for(let y=Math.max(12,rect.top+4,clip.top+4);y<Math.min(innerHeight-15,rect.bottom-4,clip.bottom-4);y+=8)if(gallery.contains(document.elementFromPoint(x,y)))return {x,y,overflow:gallery.scrollWidth>gallery.clientWidth};return {overflow:gallery.scrollWidth>gallery.clientWidth,rect:rect.toJSON(),clip:clip.toJSON()}})()");
            assert.ok(scroll.overflow, 'the full batch is bounded by a real scrollable reference surface');
            assert.ok(Number.isFinite(scroll.x)&&Number.isFinite(scroll.y), 'the native wheel reaches visible reference content: '+JSON.stringify(scroll));
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scroll.x, y: scroll.y });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroll.x, y: scroll.y, deltaX: 500, deltaY: 0 });
            try { await app.waitFor("document.querySelector('#generate-reference-sources .image-reference-grid').scrollLeft>0"); }
            catch (error) { throw new Error('Native reference scrolling: '+JSON.stringify({ point: scroll, facts: await app.evaluate(`(()=>{const gallery=document.querySelector('#generate-reference-sources .image-reference-grid'),body=document.querySelector('#image-parameter-panel .image-parameter-scroll');return {rect:gallery.getBoundingClientRect().toJSON(),overflow:getComputedStyle(gallery).overflowY,top:gallery.scrollTop,height:gallery.clientHeight,total:gallery.scrollHeight,bodyTop:body.scrollTop,hit:document.elementFromPoint(${scroll.x},${scroll.y})?.outerHTML.slice(0,300),zoom:document.getElementById('zoom-level').textContent}})()`) }), { cause: error }); }
            await focusTool(app);
            assert.equal(await app.evaluate("document.activeElement.classList.contains('image-parameter-settings-entry')"), true);
            await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-popup').hidePopover()");
            await key(app, 'Enter');
            await app.waitFor("document.querySelector('#image-parameter-panel .image-parameter-settings-popup').matches(':popover-open')");
            const enlarged = await app.evaluate("document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON()");
            assert.ok(enlarged.left>=8&&enlarged.right<=352&&enlarged.bottom<=412&&enlarged.top>=12);
            await clickVisibleSurface(app, 'image-parameter-panel');
            await focusTool(app); await checkPanel(app);
            await capture(app, `${theme}-narrow-expanded-50`, manifest);
            assert.equal(await app.evaluate('integrationPending&&integrationRequests.length===' + requests), true, 'theme, focus, scrolling and layering cannot restart or cancel the real request');
            await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        }
        assert.equal(manifest.length, 35);
        await writeFile(join(screenshotDirectory, 'manifest.json'), JSON.stringify({ browser: await app.send('Browser.getVersion'), screenshots: manifest }, null, 2));
        assert.deepEqual((await saved(app)).connections, baseline.connections);
        assert.deepEqual(getKeys(await saved(app), 'batch'), originalKeys);
        await app.evaluate("integrationHold=false;integrationRelease()");
        await app.waitFor("document.getElementById('generate-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
    });
});
