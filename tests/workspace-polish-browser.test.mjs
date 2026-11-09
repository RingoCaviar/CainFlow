import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, waitForAutosave, reloadAppBrowser } from './helpers/app-browser.mjs';

test('toolbar execution state follows the current workflow and Stop leaves background requests alive', { timeout: 60000 }, async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const fixture = { autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '对话', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-1', name: '图片', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }], nodes: [], connections: [] };
    await withAppBrowser(fixture, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `
            window.toolbarRequests=[];const originalToolbarFetch=window.fetch;
            const toolbarFrame=window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame=callback=>{
                if(window.holdNextToolbarFrame){window.holdNextToolbarFrame=false;window.releaseToolbarFrame=()=>toolbarFrame(callback);return -1;}
                return toolbarFrame(callback);
            };
            window.fetch=async(url,options={})=>{
                if(String(url)==='/proxy'&&options.body){
                    const body=options.body instanceof FormData?Object.fromEntries(options.body.entries()):JSON.parse(options.body);
                    if(body.prompt)return new Promise((resolve,reject)=>{
                        const request={prompt:body.prompt,aborted:false,release:()=>resolve(new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(png)}}]}),{headers:{'Content-Type':'application/json'}}))};
                        toolbarRequests.push(request);
                        options.signal?.addEventListener('abort',()=>{request.aborted=true;request.finishAbort=()=>reject(new DOMException('Stopped','AbortError'));},{once:true});
                    });
                }
                return originalToolbarFetch(url,options);
            };` });
        await reloadAppBrowser(app);
        await app.evaluate("document.body.classList.add('toolbar-pinned');document.getElementById('btn-theme-toggle').click();document.querySelector('#theme-menu [data-theme-id=paper]').click()");
        for (const suffix of ['a','b']) {
            const graph = { workflowId: `toolbar-workflow-${suffix}`, nodes: [{ id: `node-${suffix}`, type: 'ImageGenerate', x: 60, y: 160, width: 320, apiConfigId: 'image', providerId: 'p', prompt: suffix }], connections: [] };
            assert.equal(await app.evaluate(`fetch('/api/workflows/Toolbar-${suffix}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        }
        const activate = async suffix => {
            await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
            await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name="Toolbar-${suffix}"]'))`);
            await app.evaluate(`document.querySelector('.workflow-item[data-name="Toolbar-${suffix}"]').click()`);
            await app.waitFor(`document.getElementById('toolbar-workflow-name').textContent==='Toolbar-${suffix}'&&Boolean(document.getElementById('node-${suffix}'))`);
            await app.evaluate("document.getElementById('btn-close-workflow').click()");
        };
        const snapshot = async name => {
            if (!process.env.CAINFLOW_TOOLBAR_VISUALS) return;
            await mkdir(process.env.CAINFLOW_TOOLBAR_VISUALS, { recursive: true });
            await app.evaluate("document.querySelectorAll('.toast,.notice').forEach(element=>element.remove())");
            const shot = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(join(process.env.CAINFLOW_TOOLBAR_VISUALS, name+'.png'), Buffer.from(shot.data,'base64'));
            const clip = await app.evaluate("({x:0,y:0,width:innerWidth,height:Math.min(innerHeight,document.getElementById('toolbar').getBoundingClientRect().bottom+6),scale:1})");
            const chrome = await app.send('Page.captureScreenshot', { format: 'png', clip });
            await writeFile(join(process.env.CAINFLOW_TOOLBAR_VISUALS, name+'-toolbar.png'), Buffer.from(chrome.data,'base64'));
        };
        await activate('a');
        await snapshot('idle-paper');
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("toolbarRequests.some(request=>request.prompt==='a')&&document.getElementById('toolbar-workflow-run-status').textContent==='运行中'");
        await snapshot('running-paper');
        await activate('b');
        assert.equal(await app.evaluate("document.getElementById('btn-stop').disabled"), true);
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-run-status').hidden"), true, 'background work cannot impersonate current workflow activity');
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("toolbarRequests.some(request=>request.prompt==='b')&&document.getElementById('toolbar-workflow-run-status').textContent==='运行中'");
        const facts = [];
        for (const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
            await app.evaluate(`document.getElementById('btn-theme-toggle').click();document.querySelector('#theme-menu [data-theme-id="${theme}"]').click()`);
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            await app.waitFor("['btn-run','btn-stop'].every(id=>document.getElementById(id).getAnimations().every(animation=>animation.playState!=='running'))");
            facts.push(await app.evaluate(`(()=>{
                const status=document.getElementById('toolbar-workflow-run-status'),run=document.getElementById('btn-run'),stop=document.getElementById('btn-stop');
                const r=run.getBoundingClientRect(),s=stop.getBoundingClientRect();
                return {theme:document.documentElement.dataset.appTheme,status:status.textContent,statusColor:getComputedStyle(status).color,
                    statusRect:status.getBoundingClientRect().toJSON(),runRect:r.toJSON(),stopRect:s.toJSON(),
                    toolbarBackground:getComputedStyle(document.getElementById('toolbar')).backgroundColor,
                    runColor:getComputedStyle(run).color,runBackground:getComputedStyle(run).backgroundColor,
                    stopColor:getComputedStyle(stop).color,stopBackground:getComputedStyle(stop).backgroundColor,
                    runAnimation:getComputedStyle(run).animationName,stopAnimation:getComputedStyle(stop).animationName,heights:[r.height,s.height]};
            })()`));
            assert.deepEqual(facts.at(-1).heights, [38,38]);
            assert.equal(facts.at(-1).runAnimation, 'none'); assert.equal(facts.at(-1).stopAnimation, 'none');
            await snapshot('running-'+theme);
        }
        for (const width of [420,320]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            const narrow = await app.evaluate("(()=>{const status=document.getElementById('toolbar-workflow-run-status'),run=document.getElementById('btn-run'),stop=document.getElementById('btn-stop');return {fits:document.getElementById('toolbar').scrollWidth<=innerWidth,statusFits:status.scrollWidth<=status.clientWidth,buttons:[run,stop].map(button=>{const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})}})()");
            assert.ok(narrow.fits&&narrow.statusFits&&narrow.buttons.every(Boolean), JSON.stringify(narrow));
            await snapshot('running-'+width);
        }
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 900, deviceScaleFactor: 1, mobile: false });
        const stopping = await app.evaluate("(()=>{document.getElementById('btn-stop').click();return {message:document.getElementById('toolbar-workflow-run-status').textContent,disabled:document.getElementById('btn-stop').disabled}})()");
        assert.deepEqual(stopping, { message: '停止中', disabled: true });
        await app.waitFor("toolbarRequests.find(request=>request.prompt==='b').aborted");
        assert.equal(await app.evaluate("toolbarRequests.find(request=>request.prompt==='a').aborted"), false);
        assert.equal(await app.evaluate("document.getElementById('btn-stop').disabled"), true);
        assert.match(await app.evaluate("document.getElementById('btn-stop').textContent.trim()"), /^停止$/);
        await snapshot('after-stop');
        await app.evaluate("toolbarRequests.find(request=>request.prompt==='b').finishAbort()");
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden&&document.getElementById('btn-stop').disabled");
        await activate('a');
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-run-status').textContent"), '运行中');
        await app.evaluate("toolbarRequests.find(request=>request.prompt==='a').release()");
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden&&document.getElementById('node-a-run-status').textContent==='完成'");
        assert.equal(await app.evaluate('toolbarRequests.length'), 2);
        const preparing = await app.evaluate("(()=>{holdNextToolbarFrame=true;document.getElementById('btn-run').click();return {message:document.getElementById('toolbar-workflow-run-status').textContent,canStop:!document.getElementById('btn-stop').disabled}})()");
        assert.deepEqual(preparing, { message: '启动中', canStop: true });
        await app.evaluate("document.getElementById('btn-stop').click();releaseToolbarFrame()");
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden&&!document.getElementById('btn-run').disabled");
        assert.equal(await app.evaluate('toolbarRequests.length'), 2, 'stopping a held launch frame never sends a third provider request');
        if (process.env.CAINFLOW_TOOLBAR_VISUALS) await writeFile(join(process.env.CAINFLOW_TOOLBAR_VISUALS,'theme-facts.json'), JSON.stringify(facts,null,2));
    });
});

test('zoom percentage label opens its preset menu with a real pointer', { timeout: 20000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'zoom-source', type: 'ImageGenerate', x: 40, y: 80, width: 280, prompt: 'preview' }],
        connections: []
    }, async ({ evaluate, send, waitFor }) => {
        await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 900, deviceScaleFactor: 1, mobile: false });
        await evaluate("document.getElementById('zoom-source').click()");
        const point = await evaluate("(() => { const r=document.getElementById('zoom-level').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
        const clickPercentage = async () => {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        };
        await clickPercentage();
        await waitFor("document.querySelector('.canvas-zoom-menu').open");
        await clickPercentage();
        await waitFor("!document.querySelector('.canvas-zoom-menu').open");
    });
});

test('workflow title stays visible during automatic saving while zoom presets stay accessible', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [{ id: 'chat', modelId: 'chat', name: '示例对话模型', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '示例服务', endpoint: 'https://example.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await waitFor("window.__cainflowAppReady === true");
        await evaluate("document.body.classList.add('toolbar-pinned')");
        await waitFor("document.getElementById('toolbar-workflow-name').textContent !== '未打开工作流'");
        const name = await evaluate("document.getElementById('toolbar-workflow-name').textContent");
        assert.ok(name);
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:360,clientY:180})); document.getElementById('context-menu-search-nodes').click()");
        await evaluate("document.querySelector('.node-picker-result[data-type=TextChat]').click()");
        await waitFor("Boolean(document.querySelector('#nodes-layer .node textarea[id$=\"-prompt\"]'))");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-status').hidden"), true);
        await waitForAutosave({ waitFor });
        await evaluate("const prompt=document.querySelector('#nodes-layer textarea[id$=\"-prompt\"]'); prompt.value='为新的创作整理灵感与提示词'; prompt.dispatchEvent(new Event('input',{bubbles:true}))");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-status').hidden"), true);
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-name').textContent"), name);
        await waitForAutosave({ waitFor });
        await evaluate("document.getElementById('btn-toggle-workflow').click()");
        await waitFor("Boolean(document.querySelector('.workflow-item.is-active'))");
        await evaluate("document.querySelector('.workflow-item.is-active').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:220})); document.getElementById('menu-rename-workflow').click()");
        await waitFor("Boolean(document.getElementById('workflow-rename-input'))");
        await evaluate("document.getElementById('workflow-rename-input').value='UI体验优化'; document.querySelector('#workflow-rename-dialog [data-dialog-style-1-action=confirm]').click()");
        await waitFor("document.getElementById('toolbar-workflow-name').textContent === 'UI体验优化'");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-status').hidden"), true);
        await evaluate("document.getElementById('btn-close-workflow').click()");
        for (const [width, height] of [[1424, 900], [480, 720], [320, 240]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await evaluate("document.querySelector('.canvas-zoom-menu summary').click()");
            await waitFor("document.querySelector('.canvas-zoom-menu').open");
            if (width === 1424) {
                await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 200, deviceScaleFactor: 1, mobile: false });
                await waitFor("document.querySelector('.canvas-zoom-options').getBoundingClientRect().top >= 0");
                assert.equal(await evaluate("document.querySelector('.canvas-zoom-menu').open"), true);
                await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            }
            assert.equal(await evaluate("(() => { const r=document.querySelector('.canvas-zoom-options').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()"), true, `zoom menu bounds at ${width}x${height}`);
            await evaluate("document.querySelector('.canvas-zoom-options [data-zoom=\"0.5\"]').click()");
            assert.equal(await evaluate("document.getElementById('zoom-level').textContent"), '50%');
            assert.equal(await evaluate("document.querySelector('.canvas-zoom-menu').open"), false);
        }
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 900, deviceScaleFactor: 1, mobile: false });
            for (const theme of ['dark', 'paper']) {
                await evaluate(`document.querySelector('.canvas-zoom-menu summary').click(); document.querySelector('[data-zoom="1"]').click(); document.getElementById('btn-theme-toggle').click(); document.querySelector('#theme-menu [data-theme-id="${theme}"]').click()`);
                await new Promise(resolve => setTimeout(resolve, 350));
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `workspace-${theme}.png`), Buffer.from(shot.data, 'base64'));
            }
            await evaluate("document.getElementById('btn-settings').click(); document.querySelector('.modal-tab-btn[data-tab=general]').click()");
            for (const category of ['canvas', 'generation']) {
                await evaluate(`document.querySelector('[data-settings-category="${category}"]').click()`);
                await new Promise(resolve => setTimeout(resolve, 150));
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `settings-${category}-paper.png`), Buffer.from(shot.data, 'base64'));
            }
        }
    });
});
