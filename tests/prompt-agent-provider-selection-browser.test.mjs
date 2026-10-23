import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const providers = [{ id: 'a', name: '供应商甲', endpoint: 'https://first.test/v1', apikey: 'first-key' },
    { id: 'b', name: '供应商乙', endpoint: 'https://second.test/v1', apikey: 'second-key' }];
const models = [{ id: 'chat', name: '对话模型', modelId: 'test-chat', taskType: 'chat', protocol: 'openai', providerIds: ['a','b'], agentSearch: 'images' },
    { id: 'other', name: '另一对话模型', modelId: 'other', taskType: 'chat', protocol: 'openai', providerIds: ['a','b'] },
    { id: 'image', name: '图片模型', modelId: 'gpt-image-1', taskType: 'image', protocol: 'openai-image', providerIds: ['a','b'] }];

test('four combined menus preserve model/provider identities; real requests and statistics survive reconstruction', { timeout: 90000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, models, providers }, async ({ evaluate, send, waitFor }) => {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.calls=[];const realFetch=window.fetch;window.fetch=async(url, options={})=>{
            if(String(url)==='/proxy' && options.body){const body=JSON.parse(options.body);calls.push({body,headers:options.headers});
                if(body.messages) return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'受控方案',canvasPlan:{version:1,steps:[{id:'gen',type:'ImageGenerate',title:'海报',parameters:{prompt:'poster'}}],connections:[]}})}}]}));
                return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}));
            }return realFetch(url,options);};` });
        await send('Page.reload'); await delay(1000);
        await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await evaluate("document.getElementById('btn-prompt-agent').click();window.modelChanges=0;document.getElementById('prompt-agent-model').addEventListener('change',()=>modelChanges++)");
        const choose = async (id, model, provider) => {
            await evaluate(`document.querySelector('#${id} + button').click()`);
            await waitFor(`Boolean(document.querySelector('#${id}-menu [data-model-id="${model}"][data-provider-id="${provider}"]'))`);
            assert.equal(await evaluate(`document.getElementById('${id}-menu').textContent.includes('按优先级')`), false);
            assert.equal(await evaluate(`Boolean(document.querySelector('#${id}-menu [data-provider-id=""]:not(:disabled)'))`), false);
            await evaluate(`document.querySelector('#${id}-menu [data-model-id="${model}"][data-provider-id="${provider}"]').click()`);
        };
        await choose('prompt-agent-model','chat','b');
        assert.equal(await evaluate('modelChanges'),1);
        assert.equal(await evaluate("document.getElementById('prompt-agent-model').value"),'chat');
        await waitFor("document.querySelector('#prompt-agent-model + button')?.textContent.includes('供应商乙')");
        assert.match(await evaluate("document.querySelector('#prompt-agent-model + button').textContent"),/供应商乙/);
        await choose('prompt-agent-model','other','a');
        await evaluate("const sel=document.getElementById('prompt-agent-model');sel.value='chat';sel.dispatchEvent(new Event('change',{bubbles:true}))");
        await waitFor("document.querySelector('#prompt-agent-model + button')?.textContent.includes('供应商乙')");
        assert.match(await evaluate("document.querySelector('#prompt-agent-model + button').textContent"),/供应商乙/);
        await choose('prompt-agent-image-model','image','b');
        await evaluate("document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click();document.getElementById('prompt-agent-search-menu').open=true");
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').disabled"),false);
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-menu').open"),true);
        await evaluate("document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click()");
        for (const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-panel').style.width='300px';document.querySelector('#prompt-agent-model + button').click()`);
            assert.ok(await evaluate(`(()=>{const menu=document.getElementById('prompt-agent-model-menu'),r=menu.getBoundingClientRect(); const b=menu.querySelector('[data-provider-id="b"]'),p=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(p.x+p.width/2,p.y+p.height/2))})()`));
            if(process.env.CAINFLOW_QA_SCREENSHOT_DIR){await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`providers-${theme}.png`),Buffer.from(shot.data,'base64'));}
            await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
            assert.equal(await evaluate("Boolean(document.getElementById('prompt-agent-model-menu'))"),false);
        }
        await evaluate("document.getElementById('prompt-agent-input').value='生成海报';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate('calls.length'),1);
        const headers = await evaluate('calls[0].headers');
        assert.ok(Buffer.from(headers['x-target-url-b64'], 'base64').toString().includes('second.test'));assert.ok(JSON.stringify(headers).includes('second-key'));
        const stepId=await evaluate("document.querySelector('select[id^=agent-step-model]').id");
        await evaluate("document.querySelector('.prompt-agent-step-settings').open=true");
        await choose(stepId,'image','a');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.equal(await evaluate('calls.length'),2);
        assert.ok(await evaluate("JSON.stringify(calls[1].headers).includes('first-key')"));
        assert.equal(await evaluate("document.querySelector('#nodes-layer select[id$=provider]').value"),'a');
        const appliedNodes = await evaluate("[...document.querySelectorAll('#nodes-layer .node')].map(node=>node.id)");
        await choose(stepId,'image','b');
        assert.match(await evaluate("document.querySelector('.prompt-agent-change-list').textContent"), /供应商甲 → 供应商乙/);
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('#nodes-layer select[id$=provider]').value==='b' && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#nodes-layer .node')].map(node=>node.id)"), appliedNodes);
        assert.equal(await evaluate('calls.length'),2);
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor("document.querySelector('#nodes-layer select[id$=provider]').value==='a'");
        assert.ok(await evaluate("Boolean(document.querySelector('.prompt-agent-result-image'))"));
        await evaluate("document.getElementById('btn-toggle-statistics').click()");
        assert.equal(await evaluate("document.getElementById('statistics-total-requests').textContent"),'2');
        assert.match(await evaluate("document.getElementById('statistics-source-counts').textContent"),/画布 0 · Agent 2/);
        await delay(1200); await send('Page.reload'); await delay(1200);
        await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        await waitFor("document.querySelector('#prompt-agent-model + button')?.textContent.includes('供应商乙')");
        assert.match(await evaluate("document.querySelector('#prompt-agent-model + button').textContent"),/供应商乙/);
        assert.match(await evaluate("document.querySelector('#prompt-agent-image-model + button').textContent"),/供应商乙/);
        await evaluate("document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click();document.getElementById('prompt-agent-search-menu').open=true");
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').disabled"),false);
        await evaluate("document.getElementById('btn-toggle-statistics').click()");
        assert.equal(await evaluate("document.getElementById('statistics-total-requests').textContent"),'2');
        await evaluate("document.getElementById('btn-settings').click();const key=document.querySelector('#providers-list input[data-id=b][data-field=apikey]');key.value='';key.dispatchEvent(new Event('change',{bubbles:true}));window.__cainflowSettingsModalApi.closeSettingsModal();document.getElementById('btn-prompt-agent').click()");
        await waitFor("document.getElementById('prompt-agent-model-hint').textContent.includes('密钥')");
        await waitFor("document.querySelector('#prompt-agent-model + button')?.textContent.includes('供应商乙')");
        assert.match(await evaluate("document.querySelector('#prompt-agent-model + button').textContent"),/供应商乙/);
        await evaluate("document.getElementById('prompt-agent-input').value='不要回退';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await delay(100);
        assert.equal(await evaluate('calls.length'),0, 'invalid supplier must not use first provider');
        await evaluate("document.getElementById('prompt-agent-add-model').click()");
        await waitFor("document.activeElement?.dataset?.id==='b' && document.activeElement?.dataset?.field==='apikey'");
    });
});
