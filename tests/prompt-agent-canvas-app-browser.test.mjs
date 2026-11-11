import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('complete application previews, applies, executes and undoes a canvas plan with controlled models', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'], autoCompactTokenLimit: 100000 },
        { id: 'image-one', modelId: 'gpt-image-1', name: '图片模型一', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
        { id: 'image-two', modelId: 'gpt-image-1', name: '图片模型二', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.agentRequests=[]; window.nativeFetch=window.fetch; window.fetch=async (url,options={})=>{
            if(String(url)==='/proxy' && options.body) { const body=JSON.parse(options.body); window.agentRequests.push(body);
                if(body.messages) return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'先检查图片生成、缩放和预览方案',canvasPlan:{version:1,steps:[
                    {id:'generate',type:'ImageGenerate',title:'受控海报',parameters:{prompt:'a simple poster'}},
                    {id:'resize',type:'ImageResize',title:'调整尺寸',parameters:{scalePercent:100}},
                    {id:'save',type:'ImagePreview',title:'预览完整结果',parameters:{}}
                ],connections:[{from:{ref:'generate',port:'image'},to:{ref:'resize',port:'image'}},{from:{ref:'resize',port:'image'},to:{ref:'save',port:'image'}}]}})}}]}),{headers:{'Content-Type':'application/json'}});
                return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}),{headers:{'Content-Type':'application/json'}});
            } return window.nativeFetch(url,options);
        };` });
        await reloadAppBrowser({ evaluate, send, waitFor });
        await evaluate(` document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id=\"p\"]').click(); document.getElementById('prompt-agent-input').value='生成一张海报，调整尺寸后预览'; document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 0);
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-step-heading').length"), 3);
        assert.deepEqual(await evaluate("[...document.querySelectorAll('.prompt-agent-step-number')].map(el=>el.textContent)"), ['1', '2', '3']);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-plan-changes').open"), false);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-size-summary').closest('details').className"), 'prompt-agent-plan-changes');
        assert.equal(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').disabled"), true);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=\"image-two\"][data-provider-id=\"p\"]').click();");
        assert.equal(await evaluate("document.getElementById('prompt-agent-image-model').value"), 'image-two');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node.selected').length"), 0);
        await waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.type==='ImageGenerate')?.apiConfigId==='image-two')");
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
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='运行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束') || document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('部分步骤')");
        assert.equal(await evaluate('window.agentRequests.length'), 2, await evaluate("document.body.innerText.slice(-6000)"));
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 6);
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===3");
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已按撤销栈处理')");
        assert.ok(await evaluate("fetch('/api/storage/maintenance').then(r=>r.json()).then(s=>s.undoSession.protectedCount>0)"), 'redo protects its original media');
        await evaluate("fetch('/api/storage/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'clear-assets',mode:'node-orphans'})}).then(r=>r.json())");
        await evaluate("(() => { const canvas = document.getElementById('canvas-container'); canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })); })()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===6");
        await waitFor("[...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('已重做上一步操作'))");
        assert.equal(await evaluate('window.agentRequests.length'), 2);
        await reloadAppBrowser({ evaluate, send, waitFor });
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-result-image'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 6);
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
        { id: 'image', modelId: 'gpt-image-1', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ], providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }], autoRetry: true }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.generated=[];window.nativeFetch=fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);
                if(body.messages)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'三个方向',canvasPlan:{version:1,steps:['one','two','three'].map(id=>({id,type:'ImageGenerate',title:id,parameters:{prompt:id}})),connections:[]}})}}]}));
                generated.push(body.prompt);if(body.prompt==='two'&&generated.filter(p=>p==='two').length===1)return new Response('controlled failure',{status:500});
                return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}));
            }return nativeFetch(url,options)};` });
        await reloadAppBrowser({ evaluate, send, waitFor });
        await evaluate("document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id=\"p\"]').click();document.getElementById('prompt-agent-input').value='做三个独立方向';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=\"image\"][data-provider-id=\"p\"]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='运行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('部分步骤')");
        assert.deepEqual(await evaluate('generated'), ['one', 'two']);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-step-status[data-status=failed]').textContent"), '失败');
        assert.equal(await evaluate("document.querySelector('.prompt-agent-run-error').open"), false);
        assert.ok(await evaluate("document.querySelector('.prompt-agent-run-error p').textContent.length>0"));
        await evaluate("document.querySelector('.prompt-agent-run-error summary').click()");
        assert.equal(await evaluate("document.querySelector('.prompt-agent-run-error p').checkVisibility()"), true);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click()");
        await waitFor("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].some(b=>b.textContent==='重试未完成步骤' && !b.disabled)");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual(await evaluate('generated'), ['one', 'two', 'two', 'three']);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-result-image').length"), 3);
        const oldIds = await evaluate("[...document.querySelectorAll('#nodes-layer .node')].map(node=>node.id)");
        const removedId = await evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.find(n=>n.customTitle==='one').id)");
        await evaluate(`document.querySelector('#${removedId} .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))`);
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===2");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='运行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.match(await evaluate("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent"), /执行结束/);
        assert.deepEqual(await evaluate('generated'), ['one', 'two', 'two', 'three', 'one', 'two', 'three']);
        const newIds = await evaluate("[...document.querySelectorAll('#nodes-layer .node')].map(node=>node.id)");
        assert.equal(newIds.length, 5);
        assert.ok(!newIds.includes(removedId));
        assert.ok(oldIds.filter(id=>id!==removedId).every(id=>newIds.includes(id)), 'previous batch survivors are preserved');
        assert.equal(await evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.connections.length)"), 0);
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===2");
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-result-image').length"), 6, 'historical results survive recreation undo');
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已按撤销栈处理')");
        await evaluate(`(() => {
            const fetchBeforeRedo = window.fetch;
            window.injectedRedoConflict = false;
            window.fetch = async (url, options = {}) => {
                if (String(url).startsWith('/api/workflows/') && options.method === 'POST'
                    && JSON.parse(options.body).mediaOwnershipRestoreOwnerIds?.some(marker => marker.intent === 'redo')) {
                    window.fetch = fetchBeforeRedo;
                    const previous = await fetchBeforeRedo(url).then(response => response.json());
                    const headers = new Headers(options.headers);
                    headers.set('X-CainFlow-Expected-Media-Ownership-Revision', previous.mediaOwnershipRevision);
                    const advanced = await fetchBeforeRedo(url, { ...options, headers,
                        body: JSON.stringify({ ...previous, mediaOwnershipRevision: previous.mediaOwnershipRevision + 1 })
                    });
                    if (!advanced.ok) throw new Error('Could not advance the unchanged workflow revision');
                    window.injectedRedoConflict = true;
                }
                return fetchBeforeRedo(url, options);
            };
        })()`);
        await evaluate("document.getElementById('canvas-container').focus();document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===5");
        await waitFor("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('已重做上一步操作'))");
        assert.equal(await evaluate('injectedRedoConflict'), true);
        assert.equal(await evaluate('generated.length'), 7, 'redo does not execute');
        const rebuiltId = newIds.find(id=>!oldIds.includes(id));
        await evaluate(`document.querySelector('#${rebuiltId} .node-delete').dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true}))`);
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===4");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.match(await evaluate("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent"), /执行结束/);
        assert.deepEqual(await evaluate('generated.slice(7)'), ['one'], 'retry reruns recreated steps, not unaffected completed generators');
        await evaluate("[...document.querySelectorAll('#nodes-layer .node-delete')].forEach(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,altKey:true})))");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===0");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='运行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.match(await evaluate("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent"), /执行结束/);
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3);
        assert.equal(await evaluate('generated.length'), 11);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("generated.length===14 && !document.querySelector('#nodes-layer .node.running')");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 3, 'toolbar execution does not append save nodes');
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer [data-node-type=ImageSave]').length"), 0);
    });
});

test('plan buttons create independent batches while previous image requests remain running', { timeout: 60000 }, async () => {
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    await withAppBrowser({autoCheckUpdatesOnLoad:false,autoRetry:false,models:[
        {id:'chat',modelId:'chat',name:'对话',protocol:'openai',taskType:'chat',providerIds:['p']},
        {id:'image',modelId:'image',name:'图片',protocol:'openai',taskType:'image',providerIds:['p']}
    ],providers:[{id:'p',endpoint:'https://controlled.test/v1',apikey:'test'}]},async app=>{
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.batchErrors=[];const originalBatchError=console.error;console.error=(...args)=>{batchErrors.push(args.map(String).join(' '));originalBatchError(...args)};window.batchRequests=[];window.batchReplies=[];window.originalBatchFetch=window.fetch;window.fetch=async(url,options={})=>{
            if(window.batchFailSave&&String(url).includes('/api/workflows/')&&options.method==='POST')return new Response(JSON.stringify({error:'controlled save failure'}),{status:500});
            if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);
                if(body.messages)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'可重复使用的方案',canvasPlan:{version:1,steps:[{id:'image',type:'ImageGenerate',title:'独立图片',parameters:{prompt:'batch image'}}],connections:[]}})}}]}));
                batchRequests.push(body);return new Promise(resolve=>batchReplies.push(()=>resolve(new Response(JSON.stringify({data:[{b64_json:'${png}'}]})))));
            }return originalBatchFetch(url,options);
        };` });
        await reloadAppBrowser(app);
        await app.evaluate(`document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click();document.getElementById('prompt-agent-input').value='生成新图片';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const click=label=>app.evaluate(`[...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.prompt-agent-actions-primary button')].filter(b=>!b.hidden).map(b=>b.textContent)"),['运行','仅应用']);
        await click('运行');await app.waitFor('batchRequests.length===1');
        await app.waitFor("![...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='运行').disabled");
        await click('运行');await app.waitFor('batchRequests.length===2');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer .node').length"),2);
        await app.waitFor("![...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='仅应用').disabled");
        await app.evaluate('window.batchFailSave=true');
        await click('仅应用');
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('失败')&&document.querySelectorAll('#nodes-layer .node').length===2");
        assert.equal(await app.evaluate('batchRequests.length'),2,'failed additions leave both earlier requests running');
        await app.evaluate('window.batchFailSave=false');
        await click('仅应用');await app.waitFor("document.querySelectorAll('#nodes-layer .node').length===3");
        await app.waitFor("![...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='仅应用').disabled");
        assert.equal(await app.evaluate('batchRequests.length'),2,'Apply creates nodes without a generation request');
        await app.evaluate("(async()=>{window.batchApp=await import('/js/app/bootstrap.js').then(m=>m.bootstrapCainFlowApp());window.batchWorkflowName=batchApp.workflowManagerApi.getActiveWorkflowName()})()");
        assert.ok(await app.evaluate('batchWorkflowName'), 'A has an active saved workflow name');
        await writeFile(join(app.server.workflowsDir,'Batch B.json'),JSON.stringify({workflowId:'batch-B',nodes:[],connections:[]}));
        await app.evaluate("(async()=>{await batchApp.workflowManagerApi.openWorkflow('Batch B');document.getElementById('btn-prompt-agent').click()})()");
        await app.evaluate('batchReplies[1]();batchReplies[0]()');
        await app.waitFor("(batchApp.workflowManagerApi.getWorkflowTabSnapshot(batchWorkflowName).promptAgent.messages.find(m=>m.canvasPlan)?.runs||[]).filter(r=>r.mediaAssetKeys?.length).length===2");
        assert.equal(await app.evaluate('batchApp.workflowManagerApi.getWorkflowTabSnapshot(batchWorkflowName).nodes.length'),3);
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-result-image').length"),0,'background batches do not appear in B');
        await app.evaluate("(async()=>{window.batchReopenResult=await batchApp.workflowManagerApi.openWorkflow(batchWorkflowName);document.getElementById('btn-prompt-agent').click()})()");
        if(!await app.evaluate('batchReopenResult')) {
            assert.equal(await app.evaluate('batchApp.workflowManagerApi.getActiveWorkflowName()'),'Batch B','a completion invalidating prepared A must roll back to B rather than empty canvas');
            await app.waitFor("batchApp.workflowManagerApi.getWorkflowTabSnapshot(batchWorkflowName).promptAgent.messages.find(m=>m.canvasPlan).canvasPlan.instances.every(instance=>instance.runs.every(run=>run.status!=='running'))");
            await app.evaluate("(async()=>{batchReopenResult=await batchApp.workflowManagerApi.openWorkflow(batchWorkflowName);if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click()})()");
        }
        assert.equal(await app.evaluate('batchApp.workflowManagerApi.getActiveWorkflowName()'), await app.evaluate('batchWorkflowName'), await app.evaluate("JSON.stringify({result:batchReopenResult,expected:batchWorkflowName,id:batchApp.workflowManagerApi.getActiveWorkflowId(),errors:batchErrors})"));
        await app.waitFor("document.querySelectorAll('.prompt-agent-result-image').length===2");
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer .node').length"),3);
        if(process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});
            for(const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
                await app.evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-panel').style.width='300px';document.querySelector('.prompt-agent-canvas-plan').scrollIntoView({block:'start'})`);
                assert.ok(await app.evaluate("(()=>{const c=document.querySelector('.prompt-agent-canvas-plan'),b=[...c.querySelectorAll('.prompt-agent-actions-primary button')].filter(b=>b.checkVisibility());return c.scrollWidth<=c.clientWidth+1&&b.some(b=>b.textContent==='运行')&&b.some(b=>b.textContent==='仅应用')})()"));
                const screenshot=await app.send('Page.captureScreenshot',{format:'png'});
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`batch-${theme}.png`),Buffer.from(screenshot.data,'base64'));
            }
        }
        await reloadAppBrowser(app);await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.querySelectorAll('.prompt-agent-result-image').length===2");
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer .node').length"),3);
    });
});


test('applying an existing-node proposal repeatedly creates editable copies and preserves the original', {timeout:60000}, async()=>{
    await withAppBrowser({autoCheckUpdatesOnLoad:false,nodes:[{id:'original-text',type:'Text',x:60,y:100,width:250,text:'原始文本',customTitle:'原始节点'}],connections:[],models:[{id:'chat',modelId:'chat',name:'对话',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',endpoint:'https://controlled.test/v1',apikey:'test'}]},async app=>{
        await app.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.originalCopyFetch=window.fetch;window.copyRequests=0;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'){copyRequests++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'编辑文本副本',canvasPlan:{version:1,steps:[{id:'edit',type:'Text',nodeId:'original-text',parameters:{text:'新的文本'}}],connections:[]}})}}]}));}return originalCopyFetch(url,options)};`});
        await reloadAppBrowser(app);
        await app.evaluate(`document.getElementById('original-text').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:100,clientY:150}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:100,clientY:150}));document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.getElementById('prompt-agent-input').value='修改选中的原始节点文本';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        for(const count of [2,3]){
            await app.evaluate("[...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='仅应用').click()");
            await app.waitFor(`document.querySelectorAll('#nodes-layer .node').length===${count}`);
            await app.waitFor("![...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='仅应用').disabled");
        }
        assert.equal(await app.evaluate("document.getElementById('original-text-text').value"),'原始文本');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#nodes-layer .node:not(#original-text) textarea')].map(input=>input.value)"),['新的文本','新的文本']);
        assert.equal(await app.evaluate('copyRequests'),1);
    });
});

test('a nonexecuting generated source retains its complete cached batch without copying its prompt inputs', {timeout:60000},async()=>{
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    await withAppBrowser({autoCheckUpdatesOnLoad:false,autoRetry:false,nodes:[
        {id:'words',type:'Text',text:'cached source',x:20,y:100},
        {id:'cached-source',type:'ImageGenerate',prompt:'cached source',generationCount:2,apiConfigId:'image',providerId:'p',x:400,y:100}
    ],connections:[{id:'source-prompt',from:{nodeId:'words',port:'text'},to:{nodeId:'cached-source',port:'prompt'},type:'text'}],
    models:[{id:'image',modelId:'gemini-image',name:'图片',protocol:'google',taskType:'image',providerIds:['p']}],providers:[{id:'p',endpoint:'https://controlled.test/v1',apikey:'test'}]},async app=>{
        await app.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.cacheRequests=[];window.cacheFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){cacheRequests.push(JSON.parse(options.body));return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:cacheRequests.length===2?'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==':'${png}'}}]}}]}));}return cacheFetch(url,options)};`});
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('cached-source').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("cacheRequests.length===2&&document.getElementById('btn-stop').disabled");
        await app.evaluate(`(async()=>{window.cacheApp=await import('/js/app/bootstrap.js').then(m=>m.bootstrapCainFlowApp());const {createCanvasContext}=await import('/js/features/prompt-agent/prompt-agent-canvas-context.js');const {normalizeCanvasPlan}=await import('/js/features/prompt-agent/prompt-agent-canvas-plan.js');const graph=cacheApp.workflowManagerApi.getActiveWorkflowSnapshot();const context=createCanvasContext({workflowId:cacheApp.workflowManagerApi.getActiveWorkflowId(),nodes:graph.nodes,connections:graph.connections,selectedIds:['cached-source']});const plan=normalizeCanvasPlan({version:1,steps:[{id:'cache',type:'ImageGenerate',nodeId:'cached-source',execute:false,parameters:{}},{id:'target',type:'ImageGenerate',parameters:{prompt:'use cached source'}}],connections:[{from:{ref:'cache',port:'image'},to:{ref:'target',port:'referenceImages'}}]},context,{mentionedIds:['cached-source']});cacheApp.registry.promptAgentController.restoreWorkflow({imageModelId:'image',messages:[{role:'agent',text:'使用缓存来源',canvasPlan:plan}]});document.getElementById('btn-prompt-agent').click()})()`);
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='仅应用').click()");
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        const applied=await app.evaluate('cacheApp.workflowManagerApi.getActiveWorkflowSnapshot()');
        const imported=applied.nodes.find(node=>node.type==='ImageGenerate'&&node.id!=='cached-source'&&node.prompt==='cached source');
        assert.equal(imported.mediaAssetKeys.length,2);
        assert.ok(!applied.connections.some(edge=>edge.to.nodeId===imported.id),'cached copies have no live prompt inputs');
        assert.ok(applied.connections.some(edge=>edge.from.nodeId===imported.id&&edge.to.port==='referenceImages'));
        assert.ok(applied.connections.some(edge=>edge.id==='source-prompt'),'original source input is untouched');
        assert.equal(await app.evaluate('cacheRequests.length'),2);
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-actions-primary button')].find(b=>b.textContent==='运行').click()");
        await app.waitFor("cacheRequests.length===3&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.equal(await app.evaluate("cacheRequests.at(-1).contents.flatMap(content=>content.parts).filter(part=>part.inlineData).length"),2);
    });
});

test('Agent creates 100 empty image nodes as one undoable canvas action without media requests', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'], autoCompactTokenLimit: 100000 }
    ], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.agentRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);window.agentRequests.push(body);
                return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'创建100个空图片节点',canvasPlan:{version:1,steps:Array.from({length:100},(_,i)=>({id:'empty'+i,type:'ImageImport',title:'空图片 '+(i+1),execute:false})),connections:[]}})}}]}),{headers:{'Content-Type':'application/json'}});}
            return nativeFetch(url,options);};` });
        await reloadAppBrowser({ evaluate, send, waitFor });
        const before = await evaluate("document.querySelectorAll('#nodes-layer .node').length");
        await evaluate(`document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id="p"]').click();document.getElementById('prompt-agent-input').value='创建100个图片导入节点，只创建节点不导入图';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), before);
        assert.equal(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='运行').hidden"), true);
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor(`document.querySelectorAll('#nodes-layer .node').length===${before + 100}`);
        await waitFor("!document.querySelector('.prompt-agent-canvas-plan').classList.contains('is-busy') && ![...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').disabled");
        assert.equal(await evaluate('window.agentRequests.length'), 1);
        const grid = await evaluate(`[...document.querySelectorAll('#nodes-layer .node')].slice(-100).map(node=>({x:parseFloat(node.style.left),y:parseFloat(node.style.top)}))`);
        assert.equal(grid.length, 100);
        assert.equal(new Set(grid.map(node=>node.x)).size, 10);
        assert.equal(new Set(grid.map(node=>node.y)).size, 10);
        for (let i = 0; i < grid.length; i++) {
            assert.equal(grid[i].x, grid[i % 10].x);
            assert.equal(grid[i].y, grid[Math.floor(i / 10) * 10].y);
            if (i % 10) assert.ok(grid[i].x > grid[i - 1].x);
            if (i >= 10) assert.ok(grid[i].y > grid[i - 10].y);
        }
        await waitFor(`fetch('/api/storage/documents/session').then(r=>r.json()).then(document=>document.value.nodes.length===${before + 100})`);
        const persistedGrid = await evaluate(`fetch('/api/storage/documents/session').then(r=>r.json()).then(document=>document.value.nodes.slice(-100).map(node=>({x:node.x,y:node.y})))`);
        assert.deepEqual(persistedGrid, grid, 'saved coordinates match the visible grid');
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            await evaluate(`document.querySelector('[data-nav="fit"]').click()`);
            const screenshot = await send('Page.captureScreenshot', { format: 'png' });
            await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, 'agent-100-grid.png'), Buffer.from(screenshot.data, 'base64'));
        }
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor(`document.querySelectorAll('#nodes-layer .node').length===${before}`);
    });
});
