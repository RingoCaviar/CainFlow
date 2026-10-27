import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { parseColor, composite, contrastRatio } from './helpers/browser-theme-fixture.mjs';

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
const referenceImages = await Promise.all(['red','orange','yellow','blue','green'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-' + color + '.png', import.meta.url))).toString('base64')));

function referenceSession({ empty = false } = {}) {
    const sources = [
        { id: 'source-a', type: 'ImageGenerate', x: 0, y: 120, customTitle: '甲', apiConfigId: 'image', providerId: 'p', prompt: 'source-a', generationCount: 3 },
        { id: 'source-b', type: 'ImageGenerate', x: 0, y: 920, customTitle: '乙', apiConfigId: 'image', providerId: 'p', prompt: 'source-b', generationCount: 2 }
    ];
    if (empty) sources.push({ id: 'source-empty', type: 'ImageImport', x: 0, y: 720, customTitle: '待产出' });
    return { ...session, nodes: [...sources, { id: 'reference-target', type: 'ImageGenerate', x: 500, y: 120, apiConfigId: 'image', providerId: 'p', prompt: 'use these references' }],
        connections: sources.map((source,order)=>({ id: 'edge-'+source.id, from: { nodeId: source.id, port: 'image' }, to: { nodeId: 'reference-target', port: 'referenceImages' }, type: 'image', order })) };
}

async function reloadApp({ evaluate, send, waitFor }) {
    const previous = await evaluate('performance.timeOrigin');
    const reload = async (ignoreCache = false) => {
        await send('Page.reload', { ignoreCache });
        await waitFor(`performance.timeOrigin!==${previous} && window.__cainflowAppReady === true && document.getElementById('prompt-agent-model')?.options.length>0`);
    };
    try { await reload(); }
    catch (error) {
        if (!String(error).includes('Failed to fetch dynamically imported module')) throw error;
        await reload(true);
    }
    await delay(500);
}

async function controlImages(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.imageRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
        if(String(url)==='/proxy') { const body=JSON.parse(options.body);
            if(!body.messages && !body.contents && typeof body.prompt!=='string') return nativeFetch(url,options);
            imageRequests.push(body);
            if(window.holdPrompt && window.holdPrompt===body.prompt) await new Promise(resolve=>window.releasePromptResponse=resolve);
            if(window.failImage && !body.messages) return new Response(JSON.stringify({error:{message:'受控失败：请检查模型配置'}}),{status:400,headers:{'Content-Type':'application/json'}});
            if(body.messages) {
                const content=body.messages.at(-1).content,input=JSON.parse(Array.isArray(content)?content.find(p=>p.type==='text').text:content);
                const plan=window.assistantBatch ? {canvasPlan:{version:1,steps:[{id:'generate',type:'ImageGenerate',parameters:{prompt:'source-a',generationCount:3}}],connections:[]}} : window.assistantGenerate ? {promptPlan:{prompt:'source-a',parameters:{},imageRoles:input.images.filter(i=>i.origins.includes('本轮附件')).map(i=>({imageId:i.imageId,role:'reference',purpose:'保留主体'}))}} : {canvasPlan:{version:1,steps:[{id:'revise',type:'ImageGenerate',nodeId:window.assistantTargetId||'context-one',parameters:{prompt:'助手优化后的提示词'}}],connections:[]}};
                if(window.keepReferenceSources) plan.canvasPlan.connections=['source-b','source-a'].map((ref,order)=>({from:{ref,port:'image'},to:{ref:'revise',port:'referenceImages'},type:'image',order}));
                return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'请核对修改方案',...plan})}}]}),{headers:{'Content-Type':'application/json'}});
            }
            if(body.contents) {
                if(window.holdTargetResponse) await new Promise(resolve=>window.releaseTargetResponse=resolve);
                return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'${png}'}}]}}]}),{headers:{'Content-Type':'application/json'}});
            }
            const results=body.prompt==='source-a'?${JSON.stringify(referenceImages.slice(0,3))}:body.prompt==='source-b'?${JSON.stringify(referenceImages.slice(3))}:['data:image/png;base64,${png}'];
            const image=results[(imageRequests.filter(r=>r.prompt===body.prompt).length-1)%results.length];
            return new Response(JSON.stringify({data:[{b64_json:image.split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});
        } return nativeFetch(url,options);
    };` });
    await reloadApp(app);
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

async function generateReferenceSources(app) {
    await controlImages(app);
    for (const id of ['source-a','source-b']) {
        await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()`);
        await app.waitFor(`imageRequests.filter(r=>r.prompt==='${id}').length===${id==='source-a'?3:2} && !document.getElementById('${id}-prompt').disabled`);
        await app.waitFor(`document.querySelector('#${id}-image-results .image-node-result-count')?.textContent.endsWith('/ ${id==='source-a'?3:2}')`);
        await delay(100);
    }
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
        await reloadApp(app);
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
        await reloadApp({ evaluate, send, waitFor });
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
        await reloadApp(app);
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
        await delay(1000); await reloadApp(app);
        await waitFor("Boolean(document.getElementById('prompt-image-prompt'))");
        assert.equal(await evaluate("document.getElementById('prompt-image-prompt').value"), '本地 B');
    });
});

test('reference overview retains ordered source batches and empty sources, with original preview', { timeout: 30000 }, async () => {
    await withAppBrowser(referenceSession({ empty: true }), async app => {
        const { evaluate, waitFor, send } = app;
        await generateReferenceSources(app);
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===3");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"), ['1','2','3','4']);
        assert.match(await evaluate("document.getElementById('reference-target-reference-sources').textContent"), /尚无输出/);
        await evaluate("document.querySelector('#reference-target-reference-sources .image-reference-expand').click()");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"), ['1','2','3','4','5']);
        assert.equal(await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"4\"]').disabled"), false, 'available original can be previewed');
        await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"4\"]').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"), referenceImages[3]);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await waitFor("!document.querySelector('.fullscreen-overlay')");
        assert.equal(await evaluate('document.activeElement.dataset.referenceNumber'), '4');
        await delay(1000); await reloadApp(app);
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===3");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"), ['1','2','3','4']);
        assert.equal(await evaluate('imageRequests.length'), 0, 'reopening the overview does not generate sources');
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-locate').click()");
        assert.equal(await evaluate("document.getElementById('source-b').classList.contains('selected')"), true);
    });
});

test('reference source moves survive reload, reach the real request, and disconnect with undo', { timeout: 60000 }, async () => {
    await withAppBrowser(referenceSession(), async app => {
        const { evaluate, waitFor, send } = app;
        await generateReferenceSources(app);
        await change(evaluate, 'reference-target-apiconfig', 'google');
        assert.ok(await evaluate("Boolean(document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up'))"), 'source has an accessible move action');
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').click()");
        const order = () => evaluate("[...document.querySelectorAll('#reference-target-reference-sources .image-reference-group')].map(group=>group.dataset.referenceConnection)");
        assert.deepEqual(await order(), ['edge-source-b','edge-source-a']);
        await delay(1000); await reloadApp(app);
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===2");
        assert.deepEqual(await order(), ['edge-source-b','edge-source-a']);
        await evaluate('window.holdTargetResponse=true');
        await evaluate("document.getElementById('reference-target').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor('imageRequests.some(r=>r.contents)');
        assert.deepEqual(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)"), [...referenceImages.slice(3),...referenceImages.slice(0,3)].map(image=>image.split(',')[1]));
        assert.equal(await evaluate("document.querySelector('[data-reference-connection=\"edge-source-a\"] .image-reference-move-up').disabled"), true);
        assert.equal(await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-disconnect').disabled"), true);
        await evaluate('window.releaseTargetResponse();window.holdTargetResponse=false');
        await waitFor("!document.getElementById('reference-target-prompt').disabled"); await delay(300);
        assert.match(await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-disconnect').textContent"), /2\s*张/);
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-disconnect').click()");
        assert.deepEqual(await order(), ['edge-source-a']);
        assert.ok(await evaluate("document.getElementById('source-b')!==null"));
        await waitFor(`(async()=>{const saved=await fetch('/api/storage/documents/session').then(r=>r.json());const keys=saved.value?.nodes.find(n=>n.id==='source-b')?.mediaAssetKeys||[];return keys.length===2&&(await Promise.all(keys.map(key=>fetch('/api/storage/assets/'+encodeURIComponent(key)).then(r=>r.ok)))).every(Boolean)})()`);
        await evaluate("const canvas=document.getElementById('canvas-container');canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===2");
        await waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
        assert.deepEqual(await order(), ['edge-source-b','edge-source-a']);
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===1 && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已重做上一步操作'))");
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length===2 && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
        assert.equal(await evaluate("document.querySelector('[data-reference-connection=\"edge-source-a\"] .image-reference-drag').draggable"), true, 'source drag is available after undo');
        const dragState = await evaluate(`(()=>{const transfer=new DataTransfer(),root=document.getElementById('nodes-layer'),handle=root.querySelector('[data-reference-connection="edge-source-a"] .image-reference-drag'),target=root.querySelector('[data-reference-connection="edge-source-b"]');handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));const payload=transfer.getData('application/x-cainflow-reference');target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));return {payload,duplicates:document.querySelectorAll('[data-reference-connection="edge-source-a"]').length,toasts:[...document.querySelectorAll('.toast')].map(t=>t.textContent)}})()`);
        assert.equal(dragState.payload, 'edge-source-a', JSON.stringify(dragState));
        assert.deepEqual(await order(), ['edge-source-a','edge-source-b'], JSON.stringify(dragState));
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').click()");
        assert.deepEqual(await order(), ['edge-source-b','edge-source-a']);
    });
});

test('clone parameters remain read-only while reference connections follow canvas permissions', { timeout: 30000 }, async () => {
    const seeded = referenceSession();
    Object.assign(seeded.nodes.at(-1), { isClone: true, cloneSourceId: 'source-a' });
    await withAppBrowser(seeded, async app => {
        await generateReferenceSources(app);
        const { evaluate } = app;
        assert.equal(await evaluate("document.getElementById('reference-target-prompt').disabled"), true);
        assert.equal(await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').disabled"), false);
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').click()");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources .image-reference-group')].map(el=>el.dataset.referenceConnection)"), ['edge-source-b','edge-source-a']);
        assert.equal(await evaluate("document.getElementById('source-a-prompt').value"), 'source-a');
        assert.equal(await evaluate("document.getElementById('reference-target-prompt').disabled"), true);
    });
});

test('node assistant entry preserves text and attachments and only inserts an explicitly chosen target', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: ['context-one','context-two'].map((id,index)=>({ id, type: 'ImageGenerate', customTitle: index?'背景':'主图', x: index*500, y: 100,
        apiConfigId: 'image', providerId: 'p', prompt: id })), connections: [] }, async app => {
        const { evaluate, waitFor } = app;
        await controlImages(app);
        assert.ok(await evaluate("Boolean(document.getElementById('context-one-assistant'))"), 'node exposes its assistant entry');
        await evaluate("document.getElementById('context-one-assistant').click()");
        assert.ok(await evaluate("document.getElementById('prompt-agent-panel').classList.contains('active')"));
        const initial = await evaluate("document.getElementById('prompt-agent-input').value");
        assert.match(initial, /@主图\[context-one\]/);
        assert.equal(await evaluate("document.getElementById('prompt-agent-image-model').value"), '');
        await evaluate("document.getElementById('context-one-assistant').click()");
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), initial);
        await change(evaluate, 'prompt-agent-input', '保留我的草稿');
        await evaluate("document.getElementById('context-two-assistant').click()");
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), '保留我的草稿');
        await evaluate("document.getElementById('prompt-agent-insert-node-context').click()");
        const withTarget = await evaluate("document.getElementById('prompt-agent-input').value");
        assert.match(withTarget, /^保留我的草稿/); assert.match(withTarget, /@背景\[context-two\]/);
        await evaluate("document.getElementById('context-two-assistant').click();document.getElementById('prompt-agent-insert-node-context').click()");
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), withTarget);
        await change(evaluate, 'prompt-agent-input', '');
        await evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await (await fetch('${referenceImages[0]}')).blob()],'reference.png',{type:'image/png'}));document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
        await waitFor("document.querySelectorAll('#prompt-agent-references img').length===1 && !document.querySelector('#prompt-agent-references .is-loading')");
        await evaluate("document.getElementById('context-one-assistant').click()");
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), '');
        assert.equal(await evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 1);
        assert.match(await evaluate("document.getElementById('prompt-agent-node-context').textContent"), /主图/);
        assert.equal(await evaluate('imageRequests.length'), 0, 'preparing context never sends a provider request');
    });
});

test('prepared node mention authorizes a previewed plan only after sending and explicit application', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'context-one', type: 'ImageGenerate', customTitle: '主图', x: 100, y: 100,
        apiConfigId: 'image', providerId: 'p', prompt: 'original local prompt' }], connections: [] }, async app => {
        const { evaluate, waitFor } = app;
        await controlImages(app);
        await evaluate("document.getElementById('context-one-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click()");
        assert.equal(await evaluate('imageRequests.length'), 0);
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.getElementById('context-one-prompt').value"), 'original local prompt');
        assert.equal(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').disabled"), true);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await evaluate("document.getElementById('context-one-prompt').value"), '助手优化后的提示词');
        assert.equal(await evaluate('imageRequests.length'), 1, 'apply-only does not generate');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='撤销本次画布操作').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已按撤销栈处理')");
        assert.equal(await evaluate("document.getElementById('context-one-prompt').value"), 'original local prompt');
        assert.equal(await evaluate('imageRequests.length'), 1);
    });
});

test('node result actions stage the selected original without rewiring or shrinking its batch', { timeout: 30000 }, async () => {
    await withAppBrowser(referenceSession(), async app => {
        const { evaluate, waitFor } = app;
        await generateReferenceSources(app);
        await waitFor("Boolean(document.querySelector('#source-a-image-results .image-result-actions'))");
        await evaluate("document.querySelector('#source-a-image-results [data-result-step=\"-1\"]').click()");
        await waitFor("document.querySelector('#source-a-image-results .image-node-result-count').textContent==='2 / 3'");
        await waitFor("document.querySelector('#source-a-image-results .image-node-result-preview img')?.naturalWidth>0");
        assert.notEqual(await evaluate("document.querySelector('#source-a-image-results .image-node-result-preview img').src"), referenceImages[1], 'display thumbnail is distinct from the original');
        await evaluate("document.querySelector('#source-a-image-results [data-result-action=reference]').click()");
        await waitFor("document.querySelectorAll('#prompt-agent-references img').length===1 && !document.querySelector('#prompt-agent-references .is-loading')");
        assert.equal(await evaluate("document.querySelector('#prompt-agent-references img').src"), referenceImages[1]);
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), '');
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"), 2);
        assert.equal(await evaluate('imageRequests.length'), 5);
        await evaluate("document.querySelector('#source-a-image-results [data-result-step=\"1\"]').click()");
        await waitFor("document.querySelector('#source-a-image-results .image-node-result-count').textContent==='3 / 3'");
        assert.equal(await evaluate("document.querySelector('#prompt-agent-references img').src"), referenceImages[1], 'staged image never follows the latest viewed result');
        await evaluate("document.querySelector('#prompt-agent-references button[aria-label^=移除]').click()");
        assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node-import').length"), 1, 'removing attachment retains the imported source');
        await change(evaluate, 'reference-target-apiconfig', 'google');
        await evaluate("(()=>{const node=document.getElementById('reference-target'),r=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.left+12,clientY:r.top+12}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:r.left+12,clientY:r.top+12}));node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:180}));document.getElementById('context-menu-run-selected').click()})()");
        await waitFor('imageRequests.some(r=>r.contents)');
        assert.equal(await evaluate('imageRequests.length'), 6, 'selected-only target reuses the whole source batches');
        assert.deepEqual(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)"), referenceImages.map(image=>image.split(',')[1]));
    });
});

test('history original handoff preserves drafts, offers explicit insertion, and applies real reference edges only on confirmation', { timeout: 30000 }, async () => {
    await withAppBrowser(referenceSession(), async app => {
        const { evaluate, waitFor } = app;
        await generateReferenceSources(app);
        await change(evaluate, 'prompt-agent-input', '保留我的修改说明');
        await evaluate("document.getElementById('btn-history').click()");
        await waitFor("document.querySelectorAll('#history-list .history-card').length===5");
        await evaluate("document.querySelector('#history-list .history-card').click()");
        await waitFor("Boolean(document.querySelector('#history-image-result-actions [data-result-action=edit]'))");
        await waitFor("document.getElementById('history-preview-img').naturalWidth===1024 && !document.getElementById('history-preview-img').classList.contains('history-preview-img-loading')");
        const selectedOriginal = await evaluate("(async()=>{const blob=await (await fetch(document.getElementById('history-preview-img').src)).blob();return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)})})()");
        assert.ok(referenceImages.includes(selectedOriginal));
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#history-image-result-actions button')].slice(0,4).map(b=>b.textContent)"), ['放大','用作参考','交给助手修改','下载']);
        await evaluate("document.querySelector('#history-image-result-actions [data-result-action=edit]').click()");
        await waitFor("document.querySelectorAll('#prompt-agent-references img').length===1 && !document.querySelector('#prompt-agent-references .is-loading')");
        assert.equal(await evaluate("document.querySelector('#prompt-agent-references img').src"), selectedOriginal);
        assert.equal(await evaluate("document.getElementById('prompt-agent-input').value"), '保留我的修改说明');
        assert.equal(await evaluate("document.getElementById('history-preview-modal').classList.contains('hidden')"), true);
        await evaluate("document.getElementById('prompt-agent-insert-image-request').click()");
        assert.match(await evaluate("document.getElementById('prompt-agent-input').value"), /^保留我的修改说明\n/);
        assert.equal(await evaluate('imageRequests.length'), 5);
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"), 2);
        await evaluate("window.assistantGenerate=true;document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"), 2, 'preview never applies input edges');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)"), [selectedOriginal.split(',')[1]]);
    });
});

test('assistant batch result selects one original, retains all results on reopen, and prepares an unsent edit', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, waitFor, send } = app;
        await controlImages(app);
        await evaluate("window.assistantBatch=true;document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click()");
        await change(evaluate, 'prompt-agent-input', '生成3张色块海报');
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelectorAll('.prompt-agent-image-result').length===3");
        await evaluate("document.querySelectorAll('.prompt-agent-image-result')[1].querySelector('[data-result-action=preview]').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"), referenceImages[1]);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await waitFor("!document.querySelector('.fullscreen-overlay')");
        await evaluate("document.querySelectorAll('.prompt-agent-image-result')[1].querySelector('[data-result-action=edit]').click()");
        await waitFor("document.querySelectorAll('#prompt-agent-references img').length===1 && !document.querySelector('#prompt-agent-references .is-loading')");
        assert.equal(await evaluate("document.querySelector('#prompt-agent-references img').src"), referenceImages[1]);
        assert.match(await evaluate("document.getElementById('prompt-agent-input').value"), /这张原图为基础修改/);
        assert.equal(await evaluate('imageRequests.length'), 4, 'no request after preparing an edit');
        await delay(1000); await reloadApp(app);
        await evaluate("document.getElementById('btn-prompt-agent').click()");
        await waitFor("document.querySelectorAll('.prompt-agent-image-result').length===3");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('.prompt-agent-result-image')].map(img=>img.src)"), referenceImages.slice(0,3));
        assert.equal(await evaluate('imageRequests.length'), 0);
    });
});

test('node run-to-here limits the real scope and reports waiting, success, failure and cancellation nearby', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...session, nodes: ['scope-up','scope-target','scope-down','scope-other'].map((id,index)=>({
        id, type:'ImageGenerate', x:index*450, y:100, apiConfigId:index===0?'image':'google', providerId:'p', prompt:id
    })), connections: [
        { id:'scope-in', from:{nodeId:'scope-up',port:'image'}, to:{nodeId:'scope-target',port:'referenceImages'}, type:'image', order:0 },
        { id:'scope-out', from:{nodeId:'scope-target',port:'image'}, to:{nodeId:'scope-down',port:'referenceImages'}, type:'image', order:0 }
    ] }, async app => {
        const { evaluate, waitFor } = app;
        await controlImages(app);
        assert.equal(await evaluate("Boolean(document.getElementById('scope-target-run-to-here') || document.getElementById('scope-target-run-log'))"), false, 'node footer has no run or log buttons');
        await evaluate("window.holdPrompt='scope-up';document.getElementById('scope-target').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor('imageRequests.length===1');
        assert.equal(await evaluate("document.getElementById('scope-up-run-status').textContent"), '运行中');
        assert.equal(await evaluate("document.getElementById('scope-target-run-status').textContent"), '待运行');
        assert.equal(await evaluate("document.getElementById('scope-up-prompt').disabled"), true);
        assert.equal(await evaluate("document.getElementById('scope-up-assistant').disabled"), true);
        await evaluate("document.querySelector('#scope-target-advanced-parameters > summary').click()");
        assert.equal(await evaluate("document.getElementById('scope-target-advanced-parameters').open"),false,'queued node details obey the same active-scope lock');
        await evaluate("window.releasePromptResponse();window.holdPrompt=''");
        await waitFor("document.getElementById('scope-target-run-status').textContent==='完成'");
        assert.equal(await evaluate('imageRequests.length'), 2, 'downstream and independent branches never execute');
        assert.equal(await evaluate("document.getElementById('scope-down-run-status').textContent"), '待运行');
        await waitFor("document.getElementById('btn-stop').disabled"); await delay(300);
        await evaluate("window.failImage=true;document.getElementById('scope-up').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor('imageRequests.length>2');
        await waitFor("document.getElementById('scope-up-run-status').textContent==='失败'");
        assert.equal(await evaluate("document.getElementById('scope-up-image-results').hidden"), true, 'failed run cannot show an older image');
        assert.match(await evaluate("document.querySelector('#scope-up .node-failure-summary').textContent"), /受控失败/);
        await evaluate("document.querySelector('#log-list .log-item.error').click()");
        await waitFor("document.getElementById('modal-error').classList.contains('active')");
        assert.match(await evaluate("document.getElementById('modal-error').textContent"), /受控失败/);
        await waitFor("document.getElementById('btn-stop').disabled");
        await evaluate("document.querySelector('#modal-error .modal-close').click();window.failImage=false;window.holdPrompt='scope-up';document.getElementById('scope-up').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor("document.getElementById('scope-up-run-status').textContent==='运行中' && Boolean(window.releasePromptResponse)");
        assert.match(await evaluate("document.querySelector('#scope-up .node-failure-summary').textContent"), /受控失败/, 'previous failure stays until success');
        await evaluate("document.querySelector('#scope-up .node-run-cancel-btn').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',clientX:5,clientY:5}))");
        await delay(2100);
        await evaluate("window.releasePromptResponse();window.holdPrompt=''");
        await waitFor("document.getElementById('scope-up-run-status').textContent==='已取消'");
        assert.equal(await evaluate("document.getElementById('scope-up-image-results').hidden"), true);
        await waitFor("document.getElementById('btn-stop').disabled");
        await evaluate("document.getElementById('scope-up').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor("document.getElementById('scope-up-run-status').textContent==='完成'");
        assert.equal(await evaluate("document.querySelector('#scope-up .node-failure-summary').classList.contains('hidden')"), true);
    });
});

test('seven themes and narrow panels keep creation actions legible and keyboard reachable', { timeout: 60000 }, async () => {
    await withAppBrowser(referenceSession(), async app => {
        const { evaluate, waitFor, send } = app;
        await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1200,deviceScaleFactor:1,mobile:false});
        await generateReferenceSources(app);
        const enter=async()=>{
            await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
            await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        };
        await evaluate("document.querySelector('#reference-target-advanced-parameters > summary').focus()");
        await enter();
        assert.equal(await evaluate("document.getElementById('reference-target-advanced-parameters').open"),true);
        await enter();
        assert.equal(await evaluate("document.getElementById('reference-target-advanced-parameters').open"),false);
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').focus()");
        await enter();
        assert.equal(await evaluate("document.querySelector('#reference-target-reference-sources .image-reference-group').dataset.referenceConnection"),'edge-source-b');
        await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"1\"]').focus()");
        await enter();
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"),referenceImages[3]);
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
        await waitFor("!document.querySelector('.fullscreen-overlay')");
        assert.equal(await evaluate('document.activeElement.dataset.referenceNumber'),'1');
        await evaluate("document.getElementById('source-a-assistant').click()");
        const evidence = [];
        for (const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`);
            await delay(300);
            const rows = await evaluate(`(()=>{const root=document.getElementById('source-a');return [...root.querySelectorAll('.image-node-run-status,.image-result-actions button:not(:disabled),.image-node-result-count,.image-node-assistant,.node-select-trigger:not(:disabled)')].filter(el=>el.checkVisibility()).map(el=>{const style=getComputedStyle(el),backgrounds=[];for(let parent=el;parent;parent=parent.parentElement)backgrounds.push(getComputedStyle(parent).backgroundColor);return {text:el.textContent,color:style.color,backgrounds,font:parseFloat(style.fontSize),inside:el.getBoundingClientRect().right<=root.getBoundingClientRect().right+1}})})()`);
            assert.ok(rows.length>=6);
            for (const row of rows) {
                let background=[255,255,255,1];
                for(const color of row.backgrounds.toReversed()) background=composite(parseColor(color),background);
                const contrast=contrastRatio(composite(parseColor(row.color),background),background);
                assert.ok(contrast>=4.5, `${theme} contrast ${contrast.toFixed(2)}: ${JSON.stringify(row)}`);
                assert.ok(row.font>=13, `${theme} ${row.text}: ${row.font}px`);
                assert.ok(row.inside, `${theme} ${row.text} exceeds its node`);
                evidence.push({theme,text:row.text,contrast,font:row.font});
            }
            if(process.env.CAINFLOW_QA_SCREENSHOT_DIR){
                await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});
                const shot=await send('Page.captureScreenshot',{format:'png'});
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`image-assistant-${theme}.png`),Buffer.from(shot.data,'base64'));
            }
        }
        await evaluate("document.querySelector('#source-a-image-results [data-result-action=more]').focus()");
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await waitFor("Boolean(document.querySelector('.image-result-menu'))");
        assert.equal(await evaluate('document.activeElement.textContent'), '复制图片');
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
        await waitFor("!document.querySelector('.image-result-menu')");
        assert.equal(await evaluate('document.activeElement.dataset.resultAction'), 'more');
        await evaluate("document.getElementById('source-a-assistant').click();document.getElementById('prompt-agent-resize').focus()");
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});
        const preferred = await evaluate("document.getElementById('prompt-agent-panel').offsetWidth");
        await send('Emulation.setDeviceMetricsOverride',{width:640,height:720,deviceScaleFactor:1,mobile:false});
        await delay(150);
        const narrow = await evaluate("(()=>{const p=document.getElementById('prompt-agent-panel');return {width:p.offsetWidth,scroll:p.scrollWidth,client:p.clientWidth}})()");
        assert.ok(narrow.width<preferred); assert.ok(narrow.scroll<=narrow.client+1,JSON.stringify(narrow));
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
        await delay(150);
        assert.equal(await evaluate("document.getElementById('prompt-agent-panel').offsetWidth"),preferred,'viewport constraints never overwrite preferred width');
        if(process.env.CAINFLOW_QA_SCREENSHOT_DIR) await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,'theme-geometry.json'),JSON.stringify(evidence,null,2));
    });
});

test('old workflow completes source review, ordered generation through Agent, undo redo and reopen', { timeout: 60000 }, async () => {
    const seeded=referenceSession(),target=seeded.nodes.at(-1);
    Object.assign(target,{width:476,textareaHeights:{prompt:241},prompt:'保留的本地稿'});
    seeded.nodes.push({id:'old-text',type:'Text',x:40,y:40,text:'上游已确认描述'});
    seeded.connections.push({id:'old-prompt-link',from:{nodeId:'old-text',port:'text'},to:{nodeId:'reference-target',port:'prompt'},type:'text'});
    await withAppBrowser(seeded,async app=>{
        const {evaluate,waitFor}=app;
        await generateReferenceSources(app);
        assert.match(await evaluate("document.getElementById('reference-target-prompt-source').textContent"),/上游已确认描述/);
        assert.equal(await evaluate("document.getElementById('reference-target-prompt').value"),'保留的本地稿');
        await evaluate("document.querySelector('[data-conn-id=old-prompt-link]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.querySelector('[data-reference-connection=\"edge-source-b\"] .image-reference-move-up').click()");
        await change(evaluate,'reference-target-apiconfig','google');
        await evaluate("window.assistantTargetId='reference-target';window.keepReferenceSources=true;document.getElementById('reference-target-assistant').click();document.getElementById('prompt-agent-input').value+='使用乙和甲作为参考图，保持乙在前。';document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.equal(await evaluate("document.getElementById('reference-target-prompt').value"),'保留的本地稿');
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)"),[...referenceImages.slice(3),...referenceImages.slice(0,3)].map(image=>image.split(',')[1]));
        assert.equal(await evaluate('imageRequests.filter(r=>!r.messages).length'),6,'only five source generations and one explicit target generation');
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"),2);
        await evaluate("document.querySelector('#reference-target-image-results [data-result-action=reference]').click()");
        await waitFor("document.querySelectorAll('#prompt-agent-references img').length===1 && !document.querySelector('#prompt-agent-references .is-loading')");
        assert.equal(await evaluate("document.querySelector('#prompt-agent-references img').src"),'data:image/png;base64,'+png);
        const importId=await evaluate("document.querySelector('#nodes-layer .node-import').id");
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor(`!document.getElementById('${importId}') && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))`);
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await waitFor(`Boolean(document.getElementById('${importId}')) && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已重做上一步操作'))`);
        await delay(1000);await reloadApp(app);
        await waitFor("document.querySelector('#source-a-image-results .image-node-result-count')?.textContent.endsWith('/ 3')");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources .image-reference-locate')].map(el=>el.textContent.split(' · ')[0])"),['乙','甲']);
        assert.deepEqual(await evaluate("(()=>{const node=document.getElementById('reference-target');return {x:node.style.left,y:node.style.top,width:node.offsetWidth,promptHeight:document.getElementById('reference-target-prompt').offsetHeight}})()"),{x:'500px',y:'120px',width:476,promptHeight:241});
        assert.equal(await evaluate("document.getElementById('reference-target-prompt').value"),'助手优化后的提示词');
        assert.equal(await evaluate('imageRequests.length'),0);
    });
});

test('unsupported retained thinking remains reachable for explicit reset before running', {timeout:30000}, async()=>{
    const seeded={...session,models:session.models.map(model=>model.id==='google'?{...model,thinking:{profile:'google-image'}}:model),
        nodes:[{id:'thinking-image',type:'ImageGenerate',x:20,y:100,apiConfigId:'google',providerId:'p',prompt:'reset thinking',advancedExpanded:true,thinking:{mode:'level',value:'high'}}],connections:[]};
    await withAppBrowser(seeded,async app=>{
        const {evaluate,waitFor}=app;
        await controlImages(app);
        await change(evaluate,'thinking-image-apiconfig','image');
        assert.equal(await evaluate("document.querySelector('#thinking-image .thinking-control').hidden"),false);
        await evaluate("document.querySelector('#thinking-image .thinking-control > summary').click()");
        assert.ok(await evaluate("document.querySelector('#thinking-image .thinking-control select').checkVisibility()"));
        const field=await evaluate("document.querySelector('#thinking-image .thinking-control select').id");
        await change(evaluate,field,'inherit');
        await evaluate("document.getElementById('thinking-image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()");
        await waitFor("document.getElementById('thinking-image-run-status').textContent==='完成'");
        assert.equal(await evaluate('imageRequests.length'),1);
        assert.equal(await evaluate('imageRequests[0].prompt'),'reset thinking');
    });
});

test('disabled reference sources stay visible without consuming actual request image numbers', {timeout:30000},async()=>{
    await withAppBrowser(referenceSession(),async app=>{
        const {evaluate,waitFor}=app;
        await generateReferenceSources(app);
        await evaluate("document.querySelector('#source-a .node-bypass-btn').click()");
        await waitFor("document.getElementById('reference-target-reference-sources').textContent.includes('不参与本轮输入')");
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"),['1','2']);
        assert.match(await evaluate("document.querySelector('#reference-target-reference-sources .image-reference-group').textContent"),/甲.*3 张/s);
        await change(evaluate,'reference-target-apiconfig','google');
        await evaluate("(()=>{const node=document.getElementById('reference-target'),r=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.left+12,clientY:r.top+12}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:180}));document.getElementById('context-menu-run-selected').click()})()");
        await waitFor('imageRequests.some(r=>r.contents)');
        assert.deepEqual(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)"),referenceImages.slice(3).map(image=>image.split(',')[1]));
    });
});

test('missing first asset never shifts later originals in node and reference previews', {timeout:30000},async()=>{
    await withAppBrowser(referenceSession(),async app=>{
        const {evaluate,waitFor,send,server}=app;
        await generateReferenceSources(app);
        await delay(1000);
        const digest=createHash('sha256').update(Buffer.from(referenceImages[0].split(',')[1],'base64')).digest('hex');
        // Simulate external loss of one real file, inside this fixture's isolated temporary storage.
        await unlink(join(server.dataDir,'assets',digest.slice(0,2),digest+'.png'));
        await reloadApp(app);
        await waitFor("document.querySelectorAll('#reference-target-reference-sources [data-reference-number]').length>=3");
        await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"2\"]').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"),referenceImages[1]);
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
        await waitFor("!document.querySelector('.fullscreen-overlay')");
        const firstMissing=await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"1\"]').disabled");
        if(!firstMissing){
            await evaluate("document.querySelector('#reference-target-reference-sources [data-reference-number=\"1\"]').click()");
            await waitFor("[...document.querySelectorAll('.toast')].some(el=>el.textContent.includes('原图缺失'))");
            assert.equal(await evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"),false);
        }
        // The source still owns three durable positions. Its second result is orange, even after lazy hydration.
        for(let attempt=0;attempt<2;attempt++){
            const current=await evaluate("document.querySelector('#source-a-image-results .image-node-result-count').textContent");
            if(current==='3 / 3') break;
            await evaluate("document.querySelector('#source-a-image-results [data-result-step=\"1\"]').click()");
            await waitFor(`document.querySelector('#source-a-image-results .image-node-result-count').textContent!==${JSON.stringify(current)}`);
        }
        await evaluate("document.querySelector('#source-a-image-results [data-result-step=\"-1\"]').click()");
        await waitFor("document.querySelector('#source-a-image-results .image-node-result-count').textContent==='2 / 3'");
        await evaluate("document.querySelector('#source-a-image-results [data-result-action=preview]').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"),referenceImages[1]);
        assert.equal(await evaluate('imageRequests.length'),0,'missing-file inspection never regenerates or downloads a remote substitute');
    });
});
