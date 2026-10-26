import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] },
        { id: 'google', modelId: 'gemini-image', name: '另一图片模型', protocol: 'google', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

async function controlImages({ send, waitFor }) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.imageRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy') { const body=JSON.parse(options.body); imageRequests.push(body);
            return new Response(JSON.stringify({data:[{b64_json:'${png}'}]}),{headers:{'Content-Type':'application/json'}});
        } return nativeFetch(url,options);
    };` });
    await send('Page.reload');
    await waitFor('window.__cainflowAppReady === true');
    await waitFor("document.getElementById('prompt-agent-model')?.options.length>0");
    await delay(500);
}

async function createImage({ evaluate, waitFor }) {
    await evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}))`);
    await evaluate(`document.querySelector('.context-menu-item[data-type="ImageGenerate"]').click()`);
    await waitFor("Boolean(document.querySelector('.node-generate textarea[id$=prompt]'))");
    return evaluate("document.querySelector('.node-generate').id");
}

async function change(evaluate, id, value) {
    await evaluate(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

test('content-first image card keeps common parameters aligned with the real request and reload', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, waitFor, send } = app;
        await controlImages(app);
        const id = await createImage(app);
        assert.ok(await evaluate(`document.getElementById('${id}-prompt').getBoundingClientRect().top < document.getElementById('${id}-apiconfig').getBoundingClientRect().top`), 'prompt is presented before model configuration');
        await change(evaluate, `${id}-prompt`, 'a quiet poster');
        await change(evaluate, `${id}-resolution`, 'custom');
        await change(evaluate, `${id}-custom-resolution-width`, '1536');
        await change(evaluate, `${id}-custom-resolution-height`, '1024');
        await change(evaluate, `${id}-quality`, 'high');
        await change(evaluate, `${id}-generation-count`, '2');
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor('imageRequests.length===2');
        await waitFor(`!document.getElementById('${id}-prompt').disabled`);
        assert.deepEqual(await evaluate('imageRequests.map(r=>({prompt:r.prompt,size:r.size,quality:r.quality}))'), [
            { prompt: 'a quiet poster', size: '1536x1024', quality: 'high' },
            { prompt: 'a quiet poster', size: '1536x1024', quality: 'high' }
        ]);
        await delay(1000);
        await send('Page.reload'); await waitFor('window.__cainflowAppReady === true'); await delay(500);
        await waitFor(`Boolean(document.getElementById('${id}-prompt'))`);
        assert.equal(await evaluate(`document.getElementById('${id}-prompt').value`), 'a quiet poster');
        assert.equal(await evaluate(`document.getElementById('${id}-generation-count').value`), '2');
        await change(evaluate, `${id}-apiconfig`, 'google');
        assert.ok(await evaluate(`document.getElementById('${id}-quality-field').classList.contains('hidden')`));
    });
});

test('old image nodes retain coordinates, width and saved prompt height on reopen', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'old-image', type: 'ImageGenerate', x: 213, y: 187, width: 476,
        apiConfigId: 'image', providerId: 'p', prompt: 'saved local draft', textareaHeights: { prompt: 241 } }], connections: [] }, async ({ evaluate, waitFor, send }) => {
        await waitFor("Boolean(document.getElementById('old-image-prompt'))");
        const geometry = () => evaluate(`(()=>{const node=document.getElementById('old-image');return {x:node.style.left,y:node.style.top,width:node.offsetWidth,promptHeight:document.getElementById('old-image-prompt').offsetHeight}})()`);
        assert.deepEqual(await geometry(), { x: '213px', y: '187px', width: 476, promptHeight: 241 });
        await change(evaluate, 'old-image-prompt', 'edited local draft');
        await delay(1000);
        await send('Page.reload');
        await waitFor('window.__cainflowAppReady === true'); await delay(500);
        await waitFor("Boolean(document.getElementById('old-image-prompt'))");
        assert.deepEqual(await geometry(), { x: '213px', y: '187px', width: 476, promptHeight: 241 });
    });
});

test('advanced settings retain values and each node expansion across save and reload', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: ['one','two'].map((id,index)=>({ id, type: 'ImageGenerate', x: index*500, y: 100,
        apiConfigId: 'image', providerId: 'p', prompt: id })), connections: [] }, async app => {
        const { evaluate, waitFor, send } = app;
        await controlImages(app);
        assert.equal(await evaluate("document.getElementById('one-advanced-parameters').open"), false);
        await evaluate("document.querySelector('#one-advanced-parameters > summary').click()");
        await change(evaluate, 'one-background', 'transparent');
        await evaluate("document.querySelector('#one-advanced-parameters > summary').click()");
        assert.match(await evaluate("document.getElementById('one-advanced-summary').textContent"), /透明/);
        await evaluate("document.querySelector('#one-advanced-parameters > summary').click()");
        await delay(1000);
        await send('Page.reload'); await waitFor('window.__cainflowAppReady === true'); await delay(500);
        await waitFor("Boolean(document.getElementById('two-advanced-parameters'))");
        assert.equal(await evaluate("document.getElementById('one-advanced-parameters').open"), true);
        assert.equal(await evaluate("document.getElementById('two-advanced-parameters').open"), false);
        assert.equal(await evaluate("document.getElementById('one-background').value"), 'transparent');
        await change(evaluate, 'one-apiconfig', 'google');
        await change(evaluate, 'one-apiconfig', 'image');
        assert.equal(await evaluate("document.getElementById('one-background').value"), 'transparent');
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor('imageRequests.length===2');
        assert.equal(await evaluate("imageRequests.find(r=>r.prompt==='one').background"), 'transparent');
        await waitFor("!document.getElementById('one-prompt').disabled");
        await waitFor("!document.getElementById('two-prompt').disabled && !document.getElementById('btn-run').disabled");
        await delay(300);
        await evaluate("document.querySelector('#one-advanced-parameters > summary').click();document.getElementById('one').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor('imageRequests.length===3');
        assert.equal(await evaluate("imageRequests.filter(r=>r.prompt==='one').at(-1).background"), 'transparent');
    });
});

test('connected prompt shows its existing source while keeping the inactive local draft for disconnect', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { id: 'upstream', type: 'Text', x: 0, y: 100, text: '上游 A' },
        { id: 'prompt-image', type: 'ImageGenerate', x: 400, y: 100, apiConfigId: 'image', providerId: 'p', prompt: '本地 B' }
    ], connections: [{ id: 'prompt-edge', from: { nodeId: 'upstream', port: 'text' }, to: { nodeId: 'prompt-image', port: 'prompt' }, type: 'text' }] }, async app => {
        const { evaluate, waitFor, send } = app;
        await controlImages(app);
        assert.ok(await evaluate("document.getElementById('prompt-image-prompt').checkVisibility()"), 'inactive local draft remains readable');
        assert.equal(await evaluate("document.getElementById('prompt-image-prompt').readOnly"), true);
        assert.match(await evaluate("document.getElementById('prompt-image-prompt-source').textContent"), /上游 A/);
        await change(evaluate, 'upstream-text', '上游 A 更新');
        assert.match(await evaluate("document.getElementById('prompt-image-prompt-source').textContent"), /上游 A 更新/);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor('imageRequests.length===1');
        assert.equal(await evaluate('imageRequests[0].prompt'), '上游 A 更新');
        await waitFor("!document.getElementById('prompt-image-prompt').disabled");
        await delay(300);
        await evaluate("document.querySelector('[data-conn-id=prompt-edge]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
        assert.equal(await evaluate("document.getElementById('prompt-image-prompt').readOnly"), false);
        assert.equal(await evaluate("document.getElementById('prompt-image-prompt').value"), '本地 B');
        await evaluate("document.getElementById('prompt-image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:500,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor('imageRequests.length===2');
        assert.equal(await evaluate('imageRequests[1].prompt'), '本地 B');
        await delay(1000); await send('Page.reload'); await waitFor('window.__cainflowAppReady === true'); await delay(500);
        await waitFor("Boolean(document.getElementById('prompt-image-prompt'))");
        assert.equal(await evaluate("document.getElementById('prompt-image-prompt').value"), '本地 B');
    });
});
