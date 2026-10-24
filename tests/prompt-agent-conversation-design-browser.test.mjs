import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

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
            return {message:size('.prompt-agent-message'), input:size('#prompt-agent-input'), title:size('.prompt-agent-canvas-plan > strong'),
                model:size('.prompt-agent-model-trigger'), action:size('.prompt-agent-canvas-actions .btn'),
                step:size('.prompt-agent-step-settings'), paragraphGap:getComputedStyle(document.querySelector('.prompt-agent-message-body p')).marginBottom};})()`);
        assert.deepEqual(typography, { message: '14px', input: '14px', title: '13px', model: '13px', action: '13px', step: '12px', paragraphGap: '5px' });
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
