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
test('compact Agent settings never render inside the model row while their popover opens', { timeout: 30000 }, async () => {
    await withAppBrowser({ models, providers, autoCheckUpdatesOnLoad: false }, async ({ evaluate, send, waitFor }) => {
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        for (const id of ['prompt-agent-model', 'prompt-agent-image-model']) {
            const immediate = await evaluate(`(()=>{
                const host=document.getElementById('${id}').parentElement.querySelector('.thinking-control');
                const row=document.querySelector('.prompt-agent-settings');
                const rowHeight=row.getBoundingClientRect().height;
                host.querySelector(':scope > summary').click();
                const content=host.querySelector(':scope > .thinking-control-content');
                return {open:host.open,inRow:content?.parentElement===host,display:content&&getComputedStyle(content).display,rowGrew:row.getBoundingClientRect().height>rowHeight+1};
            })()`);
            assert.deepEqual(immediate, { open: true, inRow: true, display: 'none', rowGrew: false }, id);
            await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu'))");
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        }
    });
});
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
        await evaluate(`document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control').open=true`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu [role=radio]'))");
        assert.deepEqual(await evaluate(`(()=>{const menu=document.querySelector('.prompt-agent-thinking-menu');return {
            noHeader:!menu.querySelector('.prompt-agent-settings-heading'),
            firstSection:menu.firstElementChild.className,
            headings:[...menu.querySelectorAll('.thinking-control-group > strong')].map(node=>node.textContent),
            footerCount:menu.querySelectorAll('.prompt-agent-settings-footer').length,
            footerDivider:getComputedStyle(menu.querySelector('.prompt-agent-settings-footer')).borderTopStyle
        }})()`), { noHeader:true, firstSection:'thinking-control-group', headings:['思考程度'], footerCount:1, footerDivider:'solid' });
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.prompt-agent-thinking-menu [data-thinking-value]')].slice(0,2).map(node=>node.textContent)`),
            ['跟随模型设置','接口默认（不传思考参数）']);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-status').textContent"), '');
        assert.equal(await evaluate("Boolean(document.querySelector('.prompt-agent-thinking-menu .prompt-agent-model-search'))"), false);
        assert.equal(await evaluate("Boolean(document.querySelector('.prompt-agent-thinking-menu .thinking-control-advanced'))"), false);
        await evaluate(`const choice=document.querySelector('.prompt-agent-thinking-menu [data-thinking-value="level:low"]');choice.focus();choice.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));`);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu [data-thinking-value=\"level:medium\"]').getAttribute('aria-checked')"), 'true');
        await evaluate(`document.querySelector('.prompt-agent-thinking-menu [data-thinking-value="level:high"]').click()`);
        assert.ok(await evaluate(`document.querySelector('.prompt-agent-thinking-menu').textContent.includes('high')`));
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await delay(50);
        await evaluate(`document.getElementById('prompt-agent-image-model').parentElement.querySelector('.thinking-control').open=true`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu .prompt-agent-size-settings'))");
        assert.deepEqual(await evaluate(`(()=>{const menu=document.querySelector('.prompt-agent-thinking-menu');return {
            noHeader:!menu.querySelector('.prompt-agent-settings-heading'),
            firstSection:menu.firstElementChild.className,
            redundantHeading:!!menu.querySelector('.prompt-agent-size-settings > strong'),
            fields:[...menu.querySelectorAll('.prompt-agent-size-fields > label > span')].map(node=>node.textContent),
            fieldDivider:getComputedStyle(menu.querySelector('.prompt-agent-size-fields > label + label')).borderTopStyle,
            triggerBorder:getComputedStyle(menu.querySelector('.prompt-agent-size-fields .prompt-agent-model-trigger')).borderTopStyle,
            extraTopBorder:getComputedStyle(menu.querySelector('.prompt-agent-size-settings')).borderTopStyle,
            footerVisible:getComputedStyle(menu.querySelector('.prompt-agent-settings-footer')).display
        }})()`), {noHeader:true,firstSection:'prompt-agent-size-settings',redundantHeading:false,fields:['分辨率','画面比例'],fieldDivider:'solid',triggerBorder:'solid',extraTopBorder:'none',footerVisible:'none'});
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-thinking-menu [data-thinking-value]').length"), 0);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .prompt-agent-size-settings').textContent.includes('分辨率')"), true);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await delay(50);
        for (const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control').open=true`);
            await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu [role=radio]'))");
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
        assert.equal(await evaluate('requests.find(body=>body.contents).generationConfig.thinkingConfig.thinkingLevel'),'minimal');
        assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-result-image').length"),1);
        assert.ok(await evaluate("document.querySelector('.prompt-agent-change-list').textContent.includes('思考设置')"));
        await delay(500);
        await send('Page.reload'); await delay(1000); await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        assert.equal(await evaluate(`document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control [data-thinking-value="level:high"]').getAttribute('aria-checked')`),'true');
        assert.equal(await evaluate("document.getElementById('prompt-agent-image-model').parentElement.querySelector('.thinking-control [data-thinking-value=\"level:high\"]')"),null);
        assert.equal(await evaluate("document.querySelector('#nodes-layer .thinking-control select').value"),'level:minimal');
    });
});

test('model editor omits compatibility templates while Agent thinking controls remain', { timeout: 30000 }, async () => {
    await withAppBrowser({ models, providers, autoCheckUpdatesOnLoad: false }, async ({ evaluate, waitFor }) => {
        await evaluate("document.getElementById('btn-settings').click();document.querySelector('.model-config-card .card-header').click()");
        assert.equal(await evaluate("document.querySelectorAll('.thinking-model-settings').length"), 0);
        await evaluate("window.__cainflowSettingsModalApi.closeSettingsModal();document.getElementById('btn-prompt-agent').click()");
        await waitFor("document.querySelectorAll('.prompt-agent-settings .thinking-control').length===2");
    });
});

test('compact thinking popover groups advanced settings and applies a validated token budget explicitly', { timeout: 30000 }, async () => {
    const budgetModels = [{ id: 'budget-chat', modelId: 'qwen3.8-max', name: '受控预算模型', protocol: 'openai', taskType: 'chat', providerIds: ['qwen'],
        thinking: { profile: 'qwen', default: { mode: 'budget', value: 1024 } } }];
    const budgetProviders = [{ id: 'qwen', name: '受控 Qwen', endpoint: 'https://controlled.test/v1', apikey: 'test' }];
    await withAppBrowser({ models: budgetModels, providers: budgetProviders, autoCheckUpdatesOnLoad: false }, async ({ evaluate, waitFor }) => {
        await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
        await evaluate(`document.getElementById('btn-prompt-agent').click();
            document.querySelector('#prompt-agent-model + button').click();
            document.querySelector('#prompt-agent-model-menu [data-model-id="budget-chat"][data-provider-id="qwen"]').click();
            document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control').open=true`);
        await waitFor("Boolean(document.querySelector('.prompt-agent-thinking-menu .thinking-control-advanced'))");
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-advanced').open"), false);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-advanced > summary').textContent"), '更多选项');
        await evaluate(`document.querySelector('.prompt-agent-thinking-menu .thinking-control-advanced > summary').click();
            document.querySelector('.prompt-agent-thinking-menu [data-thinking-value="budget"]').click()`);
        assert.equal(await evaluate('document.querySelector(".prompt-agent-thinking-menu [data-thinking-value=budget]").getAttribute("aria-checked")'), 'false');
        assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('.prompt-agent-thinking-menu .thinking-budget-row input');return {min:input.min,max:input.max,apply:document.querySelector('.thinking-budget-apply').textContent}})()`),
            { min: '1', max: '32768', apply: '应用' });
        await evaluate(`document.querySelector('.thinking-budget-row input').value='40000';document.querySelector('.thinking-budget-apply').click()`);
        assert.deepEqual(await evaluate(`(()=>{const input=document.querySelector('.thinking-budget-row input'),status=document.querySelector('.prompt-agent-thinking-menu .thinking-control-status');return {rangeOverflow:input.validity.rangeOverflow,showsError:status.classList.contains('is-error')}})()`),
            { rangeOverflow: true, showsError: true });
        await evaluate(`document.querySelector('.thinking-budget-row input').value='4096';document.querySelector('.thinking-budget-apply').click()`);
        await waitFor('document.querySelector(".prompt-agent-thinking-menu [data-thinking-value=budget]")?.getAttribute("aria-checked")==="true"');
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-status').textContent"), '');
    });
});
