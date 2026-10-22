import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

test('conversation prose and compact plan remain usable in seven themes at 300px', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '受控对话模型', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
        const payload = { intent: 'generate', message: '**雪山海报**。\\n\\n- 清晨柔光\\n- 简洁构图',
            canvasPlan: { version: 1, steps: [{ id: 'generate', type: 'ImageGenerate', title: '生成雪山海报', parameters: { prompt: '清晨的雪山，柔和自然光' } }], connections: [] } };
        await evaluate(`window.originalFetch=window.fetch; window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy')return new Response(JSON.stringify({choices:[{message:{content:${JSON.stringify(JSON.stringify(payload))}}}]}));
            return window.originalFetch(url,options);
        };document.getElementById('btn-prompt-agent').click();document.getElementById('prompt-agent-panel').style.width='300px';
        document.getElementById('prompt-agent-input').value='画一张全新的雪山海报，不使用参考图';
        document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"), 0);
        assert.ok(await evaluate("document.querySelector('.prompt-agent-message-body strong')?.textContent==='雪山海报'"));
        assert.ok(await evaluate("document.querySelector('.prompt-agent-plan-inputs').textContent.includes('纯文字生成')"));
        assert.ok(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan details')].every(e=>!e.open)"));
        assert.ok(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan button[hidden]')].every(e=>getComputedStyle(e).display==='none')"));
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
                return panel.scrollWidth<=panel.clientWidth+1 && a.bottom<=b.top+1 && send.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`), `${theme}: input and actions fit and remain clickable`);
            if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
                await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `conversation-${theme}.png`), Buffer.from(shot.data, 'base64'));
            }
        }
    });
});
