import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { configuration, originals } from './helpers/image-first-integrated-fixture.mjs';

test('画布菜单创建画面风格节点并保存恢复', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',
            {bubbles:true,cancelable:true,clientX:400,clientY:300}));
            document.querySelector('.context-menu-item[data-type=VisualStyle]').click();`);
        assert.doesNotMatch(await app.evaluate('document.body.innerText'), /创建节点失败/);
        await app.waitFor("document.querySelector('#nodes-layer [data-style-field=preset]') !== null");
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer [data-style-field=preset]').length"), 1);
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
                if(body.messages) return Promise.resolve(Response.json({choices:[{message:{content:JSON.stringify({palette:'暖棕色'})}}]}));
                const response=()=>Response.json({data:[{b64_json:${JSON.stringify(originals[1].split(',')[1])}}]});
                return new Promise(resolve=>window.releaseStyleImage=()=>resolve(response()));
            }
            return originalFetch(url,options);
        };`;
    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'reference', originals[0]);
        assert.equal(await app.evaluate("document.querySelector('#style-style-preset').value"), 'natural');
        assert.equal(await app.evaluate("document.getElementById('style-style-preset').getAttribute('aria-hidden')"), null, 'native style selector remains accessible');
        await app.evaluate("import('/js/app/bootstrap.js').then(async module=>{const app=await module.bootstrapCainFlowApp();app.state.models.find(model=>model.id==='chat').name='风格分析模型';document.querySelector('#style [data-style-model]').dispatchEvent(new Event('focus'));})");
        assert.match(await app.evaluate("document.querySelector('#style [data-style-model]').selectedOptions[0].textContent"), /风格分析模型/);
        await app.evaluate("var field=document.getElementById('style-style-description');field.value='温暖的生活感';field.dispatchEvent(new Event('change',{bubbles:true}));");
        await app.evaluate("document.querySelectorAll('#style [data-style-scope]').forEach(el=>el.checked=el.dataset.styleScope==='palette');document.querySelector('#style [data-style-extract]').click()");
        await app.waitFor("document.getElementById('style-style-palette').value==='暖棕色'");
        assert.equal(await app.evaluate('styleRequests.length'), 1);
        assert.equal(await app.evaluate("document.getElementById('style-style-description').value"), '温暖的生活感');
        await app.waitFor("!document.querySelector('#style [data-style-extract]').disabled && document.getElementById('btn-stop').disabled");
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("typeof releaseStyleImage==='function'");
        assert.equal(await app.evaluate("document.getElementById('style-style-description').disabled"), true, 'style stays locked while downstream generation is running');
        await app.evaluate("var field=document.getElementById('style-style-description');field.value='不应写入';field.dispatchEvent(new Event('change',{bubbles:true}));releaseStyleImage()");
        await app.waitFor("styleRequests.length===2 && document.getElementById('btn-stop').disabled");
        assert.match(await app.evaluate('styleRequests[1].prompt'), /暖棕色/);
        await waitForAutosave(app);
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes)");
        assert.equal(saved.find(node => node.id === 'image').visualStyleSnapshot.palette, '暖棕色');
        assert.equal(saved.find(node => node.id === 'style').visualStyle.description, '温暖的生活感');
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.getElementById('style-style-palette').value"), '暖棕色');
        assert.equal(await app.evaluate('styleRequests.length'), 0, 'reload does not analyze or generate');
        await mkdir('.scratch/visual-style/screenshots', { recursive: true });
        for (const theme of ['light', 'dark']) {
            await app.evaluate(`document.documentElement.dataset.appTheme='${theme}'`);
            const { data } = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(`.scratch/visual-style/screenshots/${theme}.png`, Buffer.from(data, 'base64'));
        }
        await app.evaluate("document.querySelector('#style details:last-of-type').open=true");
        await app.waitFor("document.querySelector('#style [data-style-extract]').getBoundingClientRect().height>0");
        const expanded = await app.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('.scratch/visual-style/screenshots/expanded.png', Buffer.from(expanded.data, 'base64'));
        await app.evaluate("document.getElementById('style').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:650,clientY:230}));document.getElementById('context-menu-clone-node').click()");
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('clone-node-include-upstream').checked=false;document.getElementById('btn-confirm-clone-node-count').click()");
        await app.evaluate("var field=document.getElementById('style-style-palette');field.value='深蓝';field.dispatchEvent(new Event('change',{bubbles:true}));");
        await waitForAutosave(app);
        const changed = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes)");
        assert.equal(changed.find(node => node.cloneSourceId === 'style').visualStyle.palette, '深蓝');
        assert.equal(changed.find(node => node.id === 'image').generationRevision.dirty, true);
        assert.equal(changed.find(node => node.id === 'image').visualStyleSnapshot.palette, '暖棕色', 'old result retains its generation snapshot');
    }, { initScript });
});
