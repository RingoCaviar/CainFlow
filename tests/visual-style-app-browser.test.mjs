import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { configuration, originals } from './helpers/image-first-integrated-fixture.mjs';

test('精细度五档支持真实键盘、鼠标选择与保存', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'style', type: 'VisualStyle', x: 360, y: 80 }, { id: 'reference', type: 'ImageImport', x: 0, y: 0 }], connections: [{ id: 'ref', from: { nodeId: 'reference', port: 'image' }, to: { nodeId: 'style', port: 'image' }, type: 'image' }] }, async app => {
        const click = async selector => {
            const point = await app.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        };
        await click('#style [data-style-preview]');
        await app.evaluate("document.querySelector('[data-style-detail]').focus()");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await app.waitFor("document.querySelector('[data-style-detail]').matches(':open')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').value"), 'high');
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').value"), 'high');
        await click('#style [data-style-preview]');
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').options.length"), 5);
        for (const level of ['minimal', 'low', 'medium', 'high', 'ultra']) {
            await click('[data-style-detail]');
            await app.waitFor(`document.querySelector('[data-style-detail] option[value="${level}"]').getBoundingClientRect().height>0`);
            await click(`[data-style-detail] option[value="${level}"]`);
            assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').value"), level);
        }
        assert.ok(await app.evaluate("(()=>{const d=document.querySelector('.visual-style-detail').getBoundingClientRect(),s=document.querySelector('.visual-style-model-settings summary').getBoundingClientRect();return Math.abs(d.top+d.height/2-s.top-s.height/2)<4;})()"), 'collapsed controls share one compact row');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 540, deviceScaleFactor: 1, mobile: false });
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().right<=innerWidth");
        assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),f=p.querySelector('.visual-style-settings'),b=p.querySelector('[data-parameter-action=generate]').getBoundingClientRect();return f.scrollWidth<=f.clientWidth+1 && b.bottom<=innerHeight;})()"), 'collapsed controls fit a narrow window');
        await mkdir('.scratch/visual-style/screenshots', { recursive: true });
        const compact = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/screenshots/compact-320.png', Buffer.from(compact.data, 'base64'));
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').value"), 'ultra');
    });
});

test('风格浮层当场展开与重新打开有相同的完整高度', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'style', type: 'VisualStyle', x: 360, y: 430 }, { id: 'reference', type: 'ImageImport', x: 0, y: 0 }], connections: [{ id: 'ref', from: { nodeId: 'reference', port: 'image' }, to: { nodeId: 'style', port: 'image' }, type: 'image' }] }, async app => {
        const click = async selector => {
            const point = await app.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        };
        const settle = () => app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const measure = () => app.evaluate(`(()=>{const p=document.getElementById('image-parameter-panel'),s=p.querySelector('.image-parameter-scroll');return {height:p.offsetHeight,top:p.getBoundingClientRect().top,overflow:s.scrollHeight-s.clientHeight};})()`);
        await click('#style [data-style-preview]');
        await settle();
        const collapsed = await measure();
        await click('#style-style-description');
        await app.send('Input.insertText', { text: '保留这份风格草稿' });
        await settle();
        assert.equal((await measure()).top, collapsed.top, 'typing keeps the editor anchored');
        await app.evaluate("window.styleInputBefore=document.getElementById('style-style-description')");
        await click('#image-parameter-panel summary');
        await settle();
        assert.equal(await app.evaluate("document.activeElement===document.querySelector('#image-parameter-panel summary')"), true);
        const expanded = await measure();
        await mkdir('.scratch/visual-style/panel-resize', { recursive: true });
        const capture = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/panel-resize/expanded.png', Buffer.from(capture.data, 'base64'));
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await click('#style [data-style-preview]');
        await settle();
        const reopened = await measure();
        assert.ok(Math.abs(expanded.height - reopened.height) <= 1, JSON.stringify({ expanded, reopened }));
        assert.ok(expanded.overflow <= 1, 'available viewport space should be used before adding scrolling');
        await click('#image-parameter-panel summary');
        await settle();
        assert.ok(Math.abs((await measure()).height - collapsed.height) <= 1, 'collapsing releases the extra height');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await settle();
        assert.ok(Math.abs((await measure()).height - expanded.height) <= 1, JSON.stringify({ expanded, keyboard: await measure(), state: await app.evaluate("({open:document.querySelector('#image-parameter-panel details').open,focus:document.activeElement.tagName})") }));
        assert.equal(await app.evaluate("window.styleInputBefore===document.getElementById('style-style-description') && styleInputBefore.value==='保留这份风格草稿'"), true);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 300, deviceScaleFactor: 1, mobile: false });
        await settle();
        await app.evaluate("document.querySelector('#image-parameter-panel details').open=false");
        await settle();
        await app.evaluate("document.querySelector('#image-parameter-panel details').open=true");
        await settle();
        assert.ok((await measure()).overflow > 1, 'a truly short viewport still scrolls');
        assert.ok(await app.evaluate("(()=>{const b=document.querySelector('#image-parameter-panel [data-parameter-action=generate]').getBoundingClientRect();return b.top>=0 && b.bottom<=innerHeight;})()"), 'execution stays reachable');
        const small = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/panel-resize/short-window.png', Buffer.from(small.data, 'base64'));
    });
});

test('画布菜单创建画面风格节点并保存恢复', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',
            {bubbles:true,cancelable:true,clientX:400,clientY:300}));
            document.querySelector('.context-menu-item[data-type=VisualStyle]').click();`);
        assert.doesNotMatch(await app.evaluate('document.body.innerText'), /创建节点失败/);
        await app.waitFor("document.querySelector('#nodes-layer [data-style-preview]') !== null");
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer [data-style-preview]').length"), 1);
    });
});

test('画面风格编辑、显式提取、普通生图与保存恢复', { timeout: 90000 }, async () => {
    const fixture = { ...configuration, nodes: [
        { id: 'reference', type: 'ImageImport', x: 30, y: 80 },
        { id: 'style', type: 'VisualStyle', x: 360, y: 80, visualStyle: { preset: 'natural' }, styleModelId: 'chat', styleProviderId: 'p' },
        { id: 'image', type: 'ImageGenerate', x: 780, y: 80, prompt: '一只陶瓷杯', apiConfigId: 'image', providerId: 'p' }
    ], connections: [
        { id: 'ref', from: { nodeId: 'reference', port: 'image' }, to: { nodeId: 'style', port: 'image' }, type: 'image' },
        { id: 'style-image', from: { nodeId: 'style', port: 'style' }, to: { nodeId: 'image', port: 'style' }, type: 'style' }
    ] };
    const initScript = `window.styleRequests=[]; const originalFetch=window.fetch.bind(window);
        window.fetch=(url,options)=>{
            if(url==='/proxy' && options?.body){
                const body=options.body instanceof FormData?Object.fromEntries(options.body):JSON.parse(options.body);
                styleRequests.push(body);
                if(body.messages) return Promise.resolve(Response.json({choices:[{message:{content:JSON.stringify({description:'暖棕色，柔和自然光，细腻质感。'})}}]}));
                const response=()=>Response.json({data:[{b64_json:${JSON.stringify(originals[1].split(',')[1])}}]});
                return new Promise(resolve=>window.releaseStyleImage=()=>resolve(response()));
            }
            return originalFetch(url,options);
        };`;
    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'reference', originals[0]);
        assert.equal(await app.evaluate("document.querySelectorAll('#style textarea, #style select, #style details').length"), 0);
        assert.match(await app.evaluate("document.querySelector('#style [data-style-preview]').textContent"), /柔和自然光/);
        await app.evaluate("document.querySelector('#style [data-style-preview]').click()");
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
        assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel textarea').length"), 1);
        assert.ok(await app.evaluate("document.getElementById('style').offsetHeight <= 180"), 'style preview remains compact');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel details').open"), false);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-style-detail]').value"), 'medium');
        const initialStyle = await app.evaluate("document.getElementById('style-style-description').value");
        await app.evaluate("var detail=document.querySelector('[data-style-detail]');detail.value='high';detail.dispatchEvent(new Event('change',{bubbles:true}));");
        assert.equal(await app.evaluate("document.getElementById('style-style-description').value"), initialStyle);
        assert.equal(await app.evaluate('styleRequests.length'), 0);
        await app.evaluate("var field=document.getElementById('style-style-description');field.value='温暖的生活感';field.dispatchEvent(new Event('input',{bubbles:true}));");
        assert.equal(await app.evaluate("document.querySelector('#style [data-style-preview]').textContent"), '温暖的生活感');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').click()");
        await app.waitFor("document.getElementById('style-style-description').value.includes('暖棕色')");
        assert.equal(await app.evaluate('styleRequests.length'), 1);
        assert.match(await app.evaluate('JSON.stringify(styleRequests[0])'), /详细档/);
        await app.waitFor("document.getElementById('btn-stop').disabled");
        await app.evaluate("var field=document.getElementById('style-style-description');field.value+=' 留白充足。';field.dispatchEvent(new Event('input',{bubbles:true}));");
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("typeof releaseStyleImage==='function'");
        assert.equal(await app.evaluate("document.getElementById('style-style-description').disabled"), true, 'style stays locked while downstream generation is running');
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').disabled"), true);
        await app.evaluate("var detail=document.querySelector('[data-style-detail]');detail.value='low';detail.dispatchEvent(new Event('change',{bubbles:true}));");
        await app.evaluate("var field=document.getElementById('style-style-description');field.value='不应写入';field.dispatchEvent(new Event('input',{bubbles:true}));releaseStyleImage()");
        await app.waitFor("styleRequests.length===2 && document.getElementById('btn-stop').disabled");
        assert.match(await app.evaluate('styleRequests[1].prompt'), /暖棕色/);
        await waitForAutosave(app);
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes)");
        assert.equal(saved.find(node => node.id === 'image').visualStyleSnapshot.description, '暖棕色，柔和自然光，细腻质感。 留白充足。');
        assert.equal(saved.find(node => node.id === 'style').visualStyle.description, '暖棕色，柔和自然光，细腻质感。 留白充足。');
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelector('[data-style-detail]').value"), 'high');
        assert.equal(await app.evaluate("document.getElementById('style-style-description').value"), '暖棕色，柔和自然光，细腻质感。 留白充足。');
        await app.evaluate("document.querySelector('#style [data-style-preview]').click()");
        assert.equal(await app.evaluate('styleRequests.length'), 0, 'reload does not analyze or generate');
        await mkdir('.scratch/visual-style/screenshots', { recursive: true });
        for (const theme of ['light', 'dark', 'paper', 'pro', 'pink', 'glass-light', 'glass-dark']) {
            await app.evaluate(`document.documentElement.dataset.appTheme='${theme}'`);
            const { data } = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(`.scratch/visual-style/screenshots/${theme}.png`, Buffer.from(data, 'base64'));
        }
        await app.evaluate("document.querySelector('#image-parameter-panel details').open=true");
        await app.waitFor("document.querySelector('#image-parameter-panel [data-style-model]').getBoundingClientRect().height>0");
        const expanded = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/screenshots/expanded.png', Buffer.from(expanded.data, 'base64'));
        await app.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 560, deviceScaleFactor: 1, mobile: false });
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().right <= innerWidth");
        const bounds = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'), b=p.querySelector('[data-parameter-action=generate]').getBoundingClientRect();return {left:p.getBoundingClientRect().left,bottom:b.bottom,width:p.scrollWidth,client:p.clientWidth};})()");
        assert.ok(bounds.left >= 0 && bounds.bottom <= 560 && bounds.width <= bounds.client + 1);
        const narrow = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/screenshots/narrow.png', Buffer.from(narrow.data, 'base64'));
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("var detail=document.querySelector('[data-style-detail]');detail.value='low';detail.dispatchEvent(new Event('change',{bubbles:true}));");
        await waitForAutosave(app);
        const detailOnly = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes)");
        assert.equal(detailOnly.find(node => node.id === 'image').generationRevision.dirty, false, 'detail preference does not invalidate the current generated image');
        assert.equal(detailOnly.find(node => node.id === 'style').styleDetailLevel, 'low');
        assert.equal(await app.evaluate('styleRequests.length'), 0);
        await app.evaluate("document.getElementById('style').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById('context-menu-clone-node').click()");
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=false;document.getElementById('btn-confirm-clone-node-count').click()");
        await app.evaluate("var field=document.getElementById('style-style-description');field.value='深蓝';field.dispatchEvent(new Event('input',{bubbles:true}));");
        await waitForAutosave(app);
        const changed = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes)");
        assert.equal(changed.find(node => node.cloneSourceId === 'style').visualStyle.description, '深蓝');
        assert.equal(changed.find(node => node.cloneSourceId === 'style').styleDetailLevel, 'low');
        assert.equal(changed.find(node => node.id === 'image').generationRevision.dirty, true);
        assert.equal(changed.find(node => node.id === 'image').visualStyleSnapshot.description, '暖棕色，柔和自然光，细腻质感。 留白充足。', 'old result retains its generation snapshot');
    }, { initScript });
});

test('无参考图时隐藏提取功能并保留手动风格编辑', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'style', type: 'VisualStyle', x: 150, y: 80 }], connections: [] }, async app => {
        await app.evaluate("document.querySelector('#style [data-style-preview]').click();var field=document.getElementById('style-style-description');field.value='我的风格';field.dispatchEvent(new Event('input',{bubbles:true}))");
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').hidden"), true);
        assert.equal(await app.evaluate("document.querySelector('.visual-style-detail').getBoundingClientRect().height"), 0);
        assert.equal(await app.evaluate("document.querySelector('.visual-style-model-settings').getBoundingClientRect().height"), 0);
        assert.equal(await app.evaluate("document.getElementById('style-style-description').value"), '我的风格');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await app.waitFor("document.getElementById('image-parameter-panel').hidden");
        await app.evaluate("document.querySelector('#style [data-style-preview]').click();var field=document.getElementById('style-style-description');field.value='柔和自然光，暖棕色，简洁背景，细腻质感。\\n'.repeat(30);field.dispatchEvent(new Event('input',{bubbles:true}));");
        assert.ok(await app.evaluate("(()=>{const node=document.getElementById('style').getBoundingClientRect(),preview=document.querySelector('#style [data-style-preview]').getBoundingClientRect();return preview.bottom<=node.bottom+1;})()"), 'long style stays inside its compact card');
    });
});

test('风格预设通过真实键盘替换文本，允许编辑、重复选择并保存', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'style', type: 'VisualStyle', x: 150, y: 80,
        visualStyle: { description: '旧风格', palette: '旧配色' } }], connections: [] }, async app => {
        await app.evaluate("document.querySelector('#style [data-style-preview]').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('#style select').length"), 0);
        const selectNatural = async () => {
            await app.evaluate("document.querySelector('[data-style-preset]').focus()");
            for (const [key, code] of [['ArrowDown', 40], ['Enter', 13]]) {
                await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code });
                await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
            }
        };
        await selectNatural();
        await app.waitFor("document.querySelector('[data-style-field]').value.includes('柔和自然光')");
        const preset = await app.evaluate("document.querySelector('[data-style-field]').value");
        assert.doesNotMatch(preset, /旧风格|旧配色/);
        await app.evaluate("var f=document.querySelector('[data-style-field]');f.value='用户修改';f.dispatchEvent(new Event('input',{bubbles:true}))");
        await selectNatural();
        await app.waitFor("document.querySelector('[data-style-field]').value.includes('柔和自然光')");
        assert.equal(await app.evaluate("document.querySelector('[data-style-field]').value"), preset);
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelector('[data-style-field]').value"), preset);
        assert.equal(await app.evaluate("document.querySelector('#style [data-style-preview]').textContent"), preset);
        await app.evaluate("document.querySelector('#style [data-style-preview]').click(); var c=document.querySelector('[data-style-category]');c.value='painting';c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}))");
        assert.equal(await app.evaluate("document.querySelector('[data-style-field]').value"), preset, 'category browsing preserves text');
        assert.equal(await app.evaluate("document.querySelector('[data-style-preset]').options.length"), 8);
        await selectNatural(); // The first painting option is watercolor; use the same real keyboard interaction.
        await app.waitFor("document.querySelector('[data-style-field]').value.includes('透明色层')");
        assert.doesNotMatch(await app.evaluate("document.querySelector('[data-style-field]').value"), /柔和自然光/);

    });
});
