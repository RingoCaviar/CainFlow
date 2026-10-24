import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('complete application previews, applies, executes and undoes a canvas plan with controlled models', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'], autoCompactTokenLimit: 100000 },
        { id: 'image-one', modelId: 'gpt-image-1', name: '图片模型一', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] },
        { id: 'image-two', modelId: 'gpt-image-1', name: '图片模型二', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.agentRequests=[]; window.nativeFetch=window.fetch; window.fetch=async (url,options={})=>{
            if(String(url)==='/proxy' && options.body) { const body=JSON.parse(options.body); window.agentRequests.push(body);
                if(body.messages) return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'先检查图片生成、缩放和保存方案',canvasPlan:{version:1,steps:[
                    {id:'generate',type:'ImageGenerate',title:'受控海报',parameters:{prompt:'a simple poster'}},
                    {id:'resize',type:'ImageResize',title:'调整尺寸',parameters:{scalePercent:100}},
                    {id:'save',type:'ImageSave',title:'保存完整结果',parameters:{filename:'agent-test'}}
                ],connections:[{from:{ref:'generate',port:'image'},to:{ref:'resize',port:'image'}},{from:{ref:'resize',port:'image'},to:{ref:'save',port:'image'}}]}})}}]}),{headers:{'Content-Type':'application/json'}});
                return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}),{headers:{'Content-Type':'application/json'}});
            } return window.nativeFetch(url,options);
        };` });
        await send('Page.reload'); await delay(1000);
        await waitFor("Boolean(document.getElementById('prompt-agent-model')?.options.length)");
        await evaluate(` document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id=\"p\"]').click(); document.getElementById('prompt-agent-input').value='生成一张海报，调整尺寸后保存'; document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 0);
        assert.equal(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').disabled"), true);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=\"image-two\"][data-provider-id=\"p\"]').click();");
        assert.equal(await evaluate("document.getElementById('prompt-agent-image-model').value"), 'image-two');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node.selected').length"), 0);
        assert.equal(await evaluate("document.querySelector('#nodes-layer select[id$=apiconfig]').value"), 'image-two');
        assert.equal(await evaluate('window.agentRequests.length'), 1);
        for (const theme of ['light', 'dark', 'pink', 'pro', 'paper', 'glass-light', 'glass-dark']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-panel').style.width='300px';`);
            assert.equal(await evaluate("(()=>{const card=document.querySelector('.prompt-agent-canvas-plan');return card.scrollWidth<=card.clientWidth+1})()"), true);
            if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
                await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
                const screenshot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `canvas-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
            }
        }
        await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
        await evaluate("document.getElementById('prompt-agent-input').value='@受控';document.getElementById('prompt-agent-input').dispatchEvent(new Event('input',{bubbles:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-node-mentions'))");
        assert.equal(await evaluate("(()=>{const r=document.querySelector('.prompt-agent-node-mentions').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), true);
        await evaluate("document.getElementById('prompt-agent-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
        assert.match(await evaluate("document.getElementById('prompt-agent-input').value"), /@受控海报\[/);
        assert.equal(await evaluate('window.agentRequests.length'), 1);
        await evaluate("document.getElementById('prompt-agent-input').value=''");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束') || document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('部分步骤')");
        assert.equal(await evaluate('window.agentRequests.length'), 2, await evaluate("document.body.innerText.slice(-6000)"));
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===0");
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已按撤销栈处理')");
        assert.ok(await evaluate("fetch('/api/storage/maintenance').then(r=>r.json()).then(s=>s.undoSession.protectedCount>0)"), 'redo protects its original media');
        await evaluate("fetch('/api/storage/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'clear-assets',mode:'node-orphans'})}).then(r=>r.json())");
        await evaluate("(() => { const canvas = document.getElementById('canvas-container'); canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })); })()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===3");
        await waitFor("[...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('已重做上一步操作'))");
        assert.equal(await evaluate('window.agentRequests.length'), 2);
        await send('Page.reload'); await waitFor('window.__cainflowAppReady === true');
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-result-image'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.equal(await evaluate(`(() => {
            const node = document.querySelector('#nodes-layer .node');
            const rect = node.getBoundingClientRect();
            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: rect.left + 12, clientY: rect.top + 12 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: rect.left + 12, clientY: rect.top + 12 }));
            return document.querySelectorAll('#nodes-layer .node.selected').length;
        })()`), 1);
        await evaluate(`(() => {
            const canvas = document.getElementById('canvas-container');
            canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 8, clientY: 8 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 8, clientY: 8 }));
            canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 8, clientY: 8 }));
        })()`);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node.selected').length"), 0);
        await evaluate("window.testExitCount=0; window.pywebview={api:{finish_close:async()=>{window.testExitCount++}}}; window.confirm=message=>{window.testExitError=message;return false}; window.cainflowPrepareExit()");
        assert.equal(await evaluate('window.testExitCount'), 1, await evaluate('window.testExitError || \"desktop exit persisted\"'));
    });
});

test('sequential graph stops on failure and retries only unfinished steps without duplicate nodes', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'], autoCompactTokenLimit: 100000 },
        { id: 'image', modelId: 'gpt-image-1', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ], providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }], autoRetry: true }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.generated=[];window.nativeFetch=fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);
                if(body.messages)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'三个方向',canvasPlan:{version:1,steps:['one','two','three'].map(id=>({id,type:'ImageGenerate',title:id,parameters:{prompt:id}})),connections:[]}})}}]}));
                generated.push(body.prompt);if(body.prompt==='two'&&generated.filter(p=>p==='two').length===1)return new Response('controlled failure',{status:500});
                return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}));
            }return nativeFetch(url,options)};` });
        await send('Page.reload'); await delay(1000);
        await waitFor("Boolean(document.getElementById('prompt-agent-model')?.options.length)");
        await evaluate("document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id=\"p\"]').click();document.getElementById('prompt-agent-input').value='做三个独立方向';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=\"image\"][data-provider-id=\"p\"]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('部分步骤')");
        assert.deepEqual(await evaluate('generated'), ['one', 'two']);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 6);
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click()");
        await waitFor("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].some(b=>b.textContent==='重试未完成步骤' && !b.disabled)");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual(await evaluate('generated'), ['one', 'two', 'two', 'three']);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 6);
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-result-image').length"), 3);
    });
});
