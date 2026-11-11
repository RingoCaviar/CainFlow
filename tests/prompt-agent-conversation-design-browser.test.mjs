import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay, reloadAppBrowser } from './helpers/app-browser.mjs';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('late context images update the recreated visible workflow message after A to B to A', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-workflow-isolation.html');
    assert.equal(result.error, undefined);
    assert.equal(result.passed, true);
});

test('real workflow switching isolates Agent drafts, attachments, model choices and background replies through reload', { timeout: 60000 }, async () => {
    const configuration = { autoCheckUpdatesOnLoad: false, autoRetry: false,
        models: ['a','b'].map(id => ({ id: `chat-${id}`, modelId: `chat-model-${id}`, name: `对话${id}`, protocol: 'openai', taskType: 'chat', providerIds: ['p'] })),
        providers: [{ id: 'p', name: '测试供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };
    await withAppBrowser(configuration, async app => {
        await app.evaluate(`(async () => { window.isolationApp = await import('/js/app/bootstrap.js').then(module => module.bootstrapCainFlowApp());
            window.isolationRequests = []; window.isolationReplies = {};
            const original = window.fetch;
            window.fetch = async (url, options = {}) => {
                if (String(url) === '/proxy' && options.body) {
                    const body = JSON.parse(options.body);
                    if (body.messages) return new Promise((resolve, reject) => {
                        isolationRequests.push(body);
                        isolationReplies[body.model] = { signal: options.signal, resolve: text => resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: 'chat', message: text }) } }] }))) };
                        options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), { once: true });
                    });
                }
                return original(url, options);
            };
            isolationApp.registry.promptAgentController.restoreWorkflow({messages:[{role:'user',text:'A独有历史'}],chatModelId:'chat-a'});
            document.getElementById('btn-prompt-agent').click(); })()`);
        const nameA = await app.evaluate('isolationApp.workflowManagerApi.getActiveWorkflowName()');
        const write = value => app.evaluate(`document.getElementById('prompt-agent-input').value=${JSON.stringify(value)};document.getElementById('prompt-agent-input').dispatchEvent(new Event('input',{bubbles:true}))`);
        const send = () => app.evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await write('A自己的请求'); await send();
        await app.waitFor('isolationRequests.length === 1');
        await write('A未发送的草稿');
        await app.evaluate(`const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
            const transfer = new DataTransfer(); transfer.items.add(new File([data],'A参考图.png',{type:'image/png'}));
            document.getElementById('prompt-agent-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:transfer}));`);
        await app.waitFor("isolationApp.registry.promptAgentController.snapshotWorkflow().draft?.referenceImages?.length === 1");
        await writeFile(join(app.server.workflowsDir, 'Isolated B.json'), JSON.stringify({ workflowId: 'isolation-B', nodes: [], connections: [],
            promptAgent: { version: 1, chatModelId: 'chat-b', messages: [{ role: 'user', text: 'B独有历史' }], draft: { text: 'B预存草稿', referenceImages: [] } } }));
        await app.evaluate("(async()=>{await isolationApp.workflowManagerApi.openWorkflow('Isolated B');document.getElementById('btn-prompt-agent').click()})()");
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'B预存草稿');
        assert.equal(await app.evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 0);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-model').value"), 'chat-b');
        assert.equal(await app.evaluate("isolationReplies['chat-model-a'].signal.aborted"), false);
        await write('B自己的请求'); await send();
        await app.waitFor('isolationRequests.length === 2');
        assert.doesNotMatch(await app.evaluate('JSON.stringify(isolationRequests[1])'), /A独有历史|A自己的请求|A未发送的草稿/);
        await write('B未发送的草稿');
        await app.evaluate("isolationReplies['chat-model-a'].resolve('A专属后台回复')");
        await app.waitFor(`JSON.stringify(isolationApp.workflowManagerApi.getWorkflowTabSnapshot(${JSON.stringify(nameA)}).promptAgent).includes('A专属后台回复')`);
        assert.doesNotMatch(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /A专属后台回复/);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-send').disabled"), true);
        await app.evaluate("isolationReplies['chat-model-b'].resolve('B专属回复')");
        await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('B专属回复')");
        await app.evaluate(`(async()=>{await isolationApp.workflowManagerApi.openWorkflow(${JSON.stringify(nameA)});document.getElementById('btn-prompt-agent').click()})()`);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'A未发送的草稿');
        assert.equal(await app.evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 1);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-model').value"), 'chat-a');
        assert.doesNotMatch(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /B专属回复|B独有历史/);
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            const screenshot = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, 'workflow-isolation-A.png'), Buffer.from(screenshot.data, 'base64'));
        }
        await reloadAppBrowser(app);
        await app.evaluate("(async()=>{window.isolationApp = await import('/js/app/bootstrap.js').then(module=>module.bootstrapCainFlowApp());document.getElementById('btn-prompt-agent').click()})()");
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'A未发送的草稿');
        assert.equal(await app.evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 1);
        await app.evaluate("(async()=>{await isolationApp.workflowManagerApi.openWorkflow('Isolated B');document.getElementById('btn-prompt-agent').click()})()");
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'B未发送的草稿');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-model').value"), 'chat-b');
        assert.doesNotMatch(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /A专属后台回复/);
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            const screenshot = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, 'workflow-isolation-B.png'), Buffer.from(screenshot.data, 'base64'));
        }
    });
});

test('user message buttons copy exact text and append a reference-preserving resend without consuming the draft', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-message-actions.html');
    assert.equal(result.error, undefined);
    assert.equal(result.passed, true);
    assert.equal(result.samples.length, 42);
});

test('conversation prose and compact plan remain usable in seven themes at 300px', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '受控对话模型 · 用于检查窄面板中较长的模型名称', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
        const payload = { intent: 'generate', message: '**雪山海报**。\\n\\n- 清晨柔光\\n- 简洁构图',
            canvasPlan: { version: 1, steps: [{ id: 'generate', type: 'ImageGenerate', title: '生成雪山海报', parameters: { prompt: '清晨的雪山，柔和自然光，细致的冰晶纹理与远处连绵山脊，'.repeat(5) } }], connections: [] } };
        await evaluate(`window.originalFetch=window.fetch; window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy')return new Response(JSON.stringify({choices:[{message:{content:${JSON.stringify(JSON.stringify(payload))}}}]}));
            return window.originalFetch(url,options);
        };document.getElementById('btn-prompt-agent').click();document.getElementById('prompt-agent-panel').style.width='300px';
        document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id="chat"][data-provider-id="p"]').click();
        document.getElementById('prompt-agent-input').value='画一张全新的雪山海报，不使用参考图';
        document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 0);
        assert.ok(await evaluate("document.querySelector('.prompt-agent-message-body strong')?.textContent==='雪山海报'"));
        assert.ok(await evaluate("document.querySelector('.prompt-agent-plan-inputs').textContent.includes('纯文字生成')"));
        assert.ok(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan details')].every(e=>!e.open)"));
        assert.ok(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan button[hidden]')].every(e=>getComputedStyle(e).display==='none')"));
        const typography = await evaluate(`(()=>{const size=selector=>getComputedStyle(document.querySelector(selector)).fontSize;
            return {message:size('.prompt-agent-message'), input:size('#prompt-agent-input'), title:size('.prompt-agent-plan-header > strong'),
                model:size('.prompt-agent-model-trigger'), action:size('.prompt-agent-canvas-actions .btn'),
                step:size('.prompt-agent-step-settings'), paragraphGap:getComputedStyle(document.querySelector('.prompt-agent-message-body p')).marginBottom};})()`);
        assert.deepEqual(typography, { message: '14px', input: '14px', title: '14px', model: '13px', action: '13px', step: '12px', paragraphGap: '5px' });
        for (const theme of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`); await delay(100);
            const underlayAlpha = await evaluate(`(()=>{const canvas=document.createElement('canvas'), context=canvas.getContext('2d');
                context.fillStyle=getComputedStyle(document.getElementById('prompt-agent-panel')).backgroundColor;
                context.fillRect(0,0,1,1); return context.getImageData(0,0,1,1).data[3];})()`);
            assert.equal(underlayAlpha, theme.startsWith('glass-') ? 0 : 255, `${theme}: only glass themes permit a transparent panel`);
            const sendPoint = await evaluate(`(()=>{const r=document.getElementById('prompt-agent-send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sendPoint });
            assert.ok(await evaluate(`(()=>{return [...document.querySelectorAll('#prompt-agent-panel button, #prompt-agent-search-menu button')].every(button=>{
                const style=getComputedStyle(button);return style.boxShadow==='none' && style.backgroundImage==='none' && style.textShadow==='none' && style.filter==='none';});})()`), `${theme}: normal, disabled and hovered Agent buttons stay flat`);
            assert.ok(await evaluate(`(()=>{const panel=document.getElementById('prompt-agent-panel'), input=document.getElementById('prompt-agent-input'), send=document.getElementById('prompt-agent-send');
                const a=input.getBoundingClientRect(), b=send.getBoundingClientRect();
                const plus=document.getElementById('prompt-agent-add-reference').getBoundingClientRect();
                return panel.scrollWidth<=panel.clientWidth+1 && plus.right<=a.left && a.right<=b.left
                    && Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<=2 && Math.abs((a.top+a.bottom)/2-(plus.top+plus.bottom)/2)<=2
                    && send.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`), `${theme}: input and actions fit and remain clickable`);
            const fit = await evaluate(`(()=>{const panel=document.getElementById('prompt-agent-panel'), name=document.querySelector('.prompt-agent-settings .prompt-agent-model-trigger');
                return {nameOverflow:name.scrollWidth>name.clientWidth, ellipsis:getComputedStyle(name).textOverflow,
                    shortActions:[...panel.querySelectorAll('.prompt-agent-canvas-plan button, #prompt-agent-send')].filter(button=>getComputedStyle(button).display!=='none' && button.getBoundingClientRect().height<28).map(button=>button.textContent),
                    panelOverflow:panel.scrollWidth-panel.clientWidth};})()`);
            assert.ok(fit.nameOverflow && fit.ellipsis==='ellipsis' && fit.shortActions.length===0 && fit.panelOverflow<=1, `${theme}: ${JSON.stringify(fit)}`);
            if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
                await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `conversation-${theme}.png`), Buffer.from(shot.data, 'base64'));
            }
        }
        for (const [viewport, width] of [[1100, 480], [620, 300]]) {
            await send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 700, deviceScaleFactor: 1, mobile: false });
            await evaluate(`document.getElementById('prompt-agent-panel').style.width='${width}px'`);
            assert.ok(await evaluate(`(()=>{const panel=document.getElementById('prompt-agent-panel'), plan=panel.querySelector('.prompt-agent-canvas-plan');
                return panel.scrollWidth<=panel.clientWidth+1 && plan.scrollWidth<=plan.clientWidth+1
                    && document.getElementById('prompt-agent-send').getBoundingClientRect().height>=28;})()`), `${viewport}px viewport: long plan and composer fit`);
        }
        assert.ok(await evaluate(`(()=>{const input=document.getElementById('prompt-agent-input'),handle=document.getElementById('prompt-agent-input-resize'),a=input.getBoundingClientRect(),b=handle.getBoundingClientRect(),before=a.height;handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));return b.top>=a.top&&b.top<a.top+22&&b.right<=a.right&&input.getBoundingClientRect().height>before})()`), 'upper-right resize handle increases the input height');
        await evaluate("document.getElementById('prompt-agent-cancel').hidden=false;document.getElementById('prompt-agent-send').disabled=true");
        assert.ok(await evaluate(`(()=>{const input=document.getElementById('prompt-agent-input').getBoundingClientRect(),cancel=document.getElementById('prompt-agent-cancel'),r=cancel.getBoundingClientRect();return getComputedStyle(document.getElementById('prompt-agent-send')).display==='none'&&input.right<=r.left&&Math.abs((input.top+input.bottom)/2-(r.top+r.bottom)/2)<=2&&cancel.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), 'stop request replaces Send at the right of the text box');
    });
});
