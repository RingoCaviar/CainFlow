import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const models = [
    { id: 'chat', name: '受控对话', modelId: 'test-chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'], autoCompactTokenLimit: 100000,
        thinking: { profile: 'openai-basic', default: { mode: 'level', value: 'low' } } },
    { id: 'image', name: '受控生图', modelId: 'gemini-3.1-flash-image-preview', protocol: 'google', taskType: 'image', providerIds: ['p'],
        thinking: { profile: 'google-image', default: { mode: 'level', value: 'minimal' } } }
];
const providers = [{ id: 'p', name: '受控渠道', endpoint: 'https://controlled.test', apikey: 'test' }];
test('thinking controls persist Agent choices, apply to nodes and reach actual chat and image requests', { timeout: 60000 }, async () => {
    await withAppBrowser({ models, providers, autoCheckUpdatesOnLoad: false }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.requests=[];const original=window.fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy') {const body=JSON.parse(options.body);requests.push(body);
                if(body.messages) return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'检查方案',canvasPlan:{version:1,steps:[{id:'g',type:'ImageGenerate',title:'海报',parameters:{prompt:'poster'}}],connections:[]}})}}]}),{headers:{'Content-Type':'application/json'}});
                return new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,inlineData:{data:'NOT_AN_IMAGE',mimeType:'image/png'}},{inlineData:{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',mimeType:'image/png'}}]}}]}),{headers:{'Content-Type':'application/json'}});
            }return original(url,options);
        };` });
        await send('Page.reload'); await delay(1000); await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await waitFor("document.querySelectorAll('.prompt-agent-settings .thinking-control').length===2");
        await evaluate(`document.getElementById('btn-prompt-agent').click(); document.getElementById('prompt-agent-panel').style.width='300px';
            for(const [id,model] of [['prompt-agent-model','chat'],['prompt-agent-image-model','image']]) {
                document.querySelector('#'+id+' + button').click();document.querySelector('#'+id+'-menu [data-model-id="'+model+'"][data-provider-id="p"]').click();
            }`);
        for (const id of ['prompt-agent-model', 'prompt-agent-image-model']) {
            await evaluate(`document.getElementById('${id}').parentElement.querySelector('.thinking-control').open=true`);
            await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu select'))");
            await evaluate(`var choice=document.querySelector('.prompt-agent-thinking-menu select');choice.value='level:high';choice.dispatchEvent(new Event('change',{bubbles:true}));`);
            assert.ok(await evaluate(`document.querySelector('.prompt-agent-thinking-menu').textContent.includes('high')`), id + ': ' + await evaluate(`document.querySelector('.prompt-agent-thinking-menu').textContent`));
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await delay(50);
        }
        for (const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control').open=true`);
            await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu select'))");
            assert.ok(await evaluate(`(()=>{const el=document.querySelector('.prompt-agent-thinking-menu'),r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&getComputedStyle(el).backgroundColor!=='rgba(0, 0, 0, 0)'})()`),theme);
            if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) { await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`thinking-${theme}.png`),Buffer.from(shot.data,'base64')); }
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); await delay(50);
        }
        await evaluate(`document.getElementById('prompt-agent-input').value='生成海报';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate('requests[0].reasoning_effort'),'high');
        await evaluate(`[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()`);
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')",20000);
        assert.ok(await evaluate('requests.some(body=>body.contents)'), await evaluate("document.getElementById('prompt-agent-panel').innerText + document.getElementById('nodes-layer').innerText"));
        assert.equal(await evaluate('requests.find(body=>body.contents).generationConfig.thinkingConfig.thinkingLevel'),'high');
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-result-image').length"),1);
        assert.ok(await evaluate("document.querySelector('.prompt-agent-change-list').textContent.includes('思考设置')"));
        await delay(500);
        await send('Page.reload'); await delay(1000); await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        for (const id of ['prompt-agent-model','prompt-agent-image-model']) {
            assert.equal(await evaluate(`document.getElementById('${id}').parentElement.querySelector('.thinking-control select').value`),'level:high');
        }
        assert.equal(await evaluate("document.querySelector('#nodes-layer .thinking-control select').value"),'level:high');
    });
});

test('model and Provider thinking templates persist through settings edits and application reconstruction', { timeout: 30000 }, async () => {
    await withAppBrowser({ models, providers, autoCheckUpdatesOnLoad: false }, async ({ evaluate, send, waitFor }) => {
        await waitFor("document.querySelectorAll('.thinking-model-settings').length===2");
        await evaluate(`var profile=document.querySelector('.thinking-model-settings > label > select');profile.value='openai-max';profile.dispatchEvent(new Event('change',{bubbles:true}));`);
        await evaluate(`var override=document.querySelectorAll('.thinking-model-settings > label > select')[1];override.value='openai-basic';override.dispatchEvent(new Event('change',{bubbles:true}));`);
        await evaluate(`var choice=document.querySelector('.thinking-model-settings .thinking-control select');choice.value='level:high';choice.dispatchEvent(new Event('change',{bubbles:true}));`);
        await delay(1000);
        await send('Page.reload'); await delay(1000);
        await waitFor("document.querySelectorAll('.thinking-model-settings').length===2");
        assert.deepEqual(await evaluate(`[...document.querySelector('.thinking-model-settings').querySelectorAll('select')].map(s=>s.value)`), ['openai-max','openai-basic','level:high']);
        assert.ok(await evaluate(`[...document.querySelector('.thinking-model-settings > label > select').options].every(o=>!o.value.startsWith('google'))`));
    });
});
