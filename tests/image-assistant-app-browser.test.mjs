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
            if(window.failImage && !body.messages) return new Response(JSON.stringify({error:{message:window.failImageMessage||'受控失败：请检查模型配置'}}),{status:400,headers:{'Content-Type':'application/json'}});
            if(window.failChainTarget && body.contents && JSON.stringify(body.contents).includes('chain-target')) return new Response(JSON.stringify({error:{message:'受控下游失败'}}),{status:400,headers:{'Content-Type':'application/json'}});
            if(body.messages) {
                const content=body.messages.at(-1).content,input=JSON.parse(Array.isArray(content)?content.find(p=>p.type==='text').text:content);
                if(Array.isArray(input.records)) return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'用户要求保留参考来源、完整批次与顺序，仅优化提示词；画布方案仍待用户确认。'})}}]}),{headers:{'Content-Type':'application/json'}});
                const plan=window.assistantChain ? {canvasPlan:{version:1,steps:[{id:'up',type:'ImageGenerate',title:'链路上游',parameters:{prompt:'chain-source'}},{id:'down',type:'ImageGenerate',title:'链路目标',parameters:{prompt:'chain-target'}}],connections:[{from:{ref:'up',port:'image'},to:{ref:'down',port:'referenceImages'},order:0}]}} : window.assistantPromptOnly ? {targetSelection:{mode:'prompt-only',evidence:'只改提示词'},promptPlan:{prompt:'多轮优化后的提示词',parameters:{},imageRoles:[]}} : window.assistantLegacy ? {promptPlan:{targetNodeId:window.assistantTargetId,prompt:'助手优化后的提示词',parameters:{},imageRoles:[]}} : window.assistantBatch ? {canvasPlan:{version:1,steps:[{id:'generate',type:'ImageGenerate',parameters:{prompt:'source-a',generationCount:3}}],connections:[]}} : window.assistantGenerate ? {promptPlan:{prompt:'source-a',parameters:{},imageRoles:input.images.filter(i=>i.origins.includes('本轮附件')).map(i=>({imageId:i.imageId,role:'reference',purpose:'保留主体'}))}} : {canvasPlan:{version:1,steps:[{id:'revise',type:'ImageGenerate',nodeId:window.assistantTargetId||'context-one',...(window.assistantEvidence?{evidence:window.assistantEvidence}:{}),parameters:{prompt:'助手优化后的提示词'}}],connections:[]}};
                if(window.keepReferenceSources) plan.canvasPlan.connections=['source-b','source-a'].map((ref,order)=>({from:{ref,port:'image'},to:{ref:'revise',port:'referenceImages'},type:'image',order}));
                return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:window.assistantPromptOnly?'refine':'generate',message:'请核对修改方案',...plan})}}]}),{headers:{'Content-Type':'application/json'}});
            }
            if(body.contents) {
                if(window.holdTargetResponse) await new Promise(resolve=>window.releaseTargetResponse=resolve);
                return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:window.alternateGeneratedImage?'${referenceImages[4].split(',')[1]}':'${png}'}}]}}]}),{headers:{'Content-Type':'application/json'}});
            }
            const results=body.prompt==='source-a'?${JSON.stringify(referenceImages.slice(0,3))}:body.prompt==='source-b'?${JSON.stringify(referenceImages.slice(3))}:['data:image/png;base64,${png}'];
            const image=window.sameReferencePixels?'${referenceImages[0]}':results[(imageRequests.filter(r=>r.prompt===body.prompt).length-1)%results.length];
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

async function generateReferenceSources(app, { samePixels = false } = {}) {
    await controlImages(app);
    if (samePixels) await app.evaluate('window.sameReferencePixels=true');
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
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"), ['1','2','3','4','5']);
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
        assert.deepEqual(await evaluate("[...document.querySelectorAll('#reference-target-reference-sources [data-reference-number]')].map(el=>el.dataset.referenceNumber)"), ['1','2','3','4','5']);
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


test('assistant optimization sends the mentioned generation target reference originals in connection order', { timeout: 30000 }, async () => {
    const seeded = referenceSession();
    seeded.connections[0].order = 1; seeded.connections[1].order = 0;
    await withAppBrowser(seeded, async app => {
        const { evaluate, waitFor } = app;
        await generateReferenceSources(app);
        await evaluate("window.assistantTargetId='reference-target';document.getElementById('reference-target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click()");
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("imageRequests.some(r=>r.messages)");
        const images = await evaluate("imageRequests.find(r=>r.messages).messages.at(-1).content.filter(p=>p.type==='image_url').map(p=>p.image_url.url)");
        assert.deepEqual(images.map(image=>createHash('sha256').update(image).digest('hex')), [...referenceImages.slice(3), ...referenceImages.slice(0,3)].map(image=>createHash('sha256').update(image).digest('hex')), 'mentioning a generation target supplies all five original reference images, not just topology or an unrelated selected output');
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.some(r=>r.contents)");
        const generationImages = await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.deepEqual(generationImages.map(image=>createHash('sha256').update(image).digest('hex')), [...referenceImages.slice(3),...referenceImages.slice(0,3)].map(image=>createHash('sha256').update(image.split(',')[1]).digest('hex')), 'applying a prompt-only plan retains all ordered reference connections in the generation request');

    });
});


test('many reference sources stay in a compact wrapping gallery with every original accessible', { timeout: 30000 }, async () => {
    const sources = Array.from({length:16}, (_,index)=>({id:'compact-'+index,type:'ImageImport',customTitle:'参考素材 '+(index+1),x:-800,y:index*200}));
    await withAppBrowser({...session,nodes:[...sources,{id:'compact-target',type:'ImageGenerate',x:100,y:100,apiConfigId:'image',providerId:'p',prompt:'保留参考图'}],connections:sources.map((source,order)=>({id:'compact-edge-'+order,from:{nodeId:source.id,port:'image'},to:{nodeId:'compact-target',port:'referenceImages'},type:'image',order}))}, async app => {
        const {evaluate,waitFor,send}=app;
        await waitFor("document.querySelectorAll('#compact-target-reference-sources .image-reference-group').length===16");
        await evaluate(`(async()=>{const images=${JSON.stringify(referenceImages)};for(let index=0;index<16;index++){const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(images[index%5])).blob()],'reference-'+index+'.png',{type:'image/png'}));const input=document.getElementById('compact-'+index+'-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
        await waitFor("document.querySelectorAll('#compact-target-reference-sources [data-reference-number]').length===16");
        await delay(1000); // Let the real import/media-save queue settle before opening an original.

        const layout = await evaluate("(()=>{const root=document.getElementById('compact-target-reference-sources'),groups=[...root.querySelectorAll('.image-reference-group')];return {height:root.offsetHeight,tops:groups.slice(0,2).map(el=>el.offsetTop),overflow:root.scrollWidth>root.clientWidth+1,images:root.querySelectorAll('[data-reference-number]').length}})()");
        assert.ok(layout.height<=270, 'sixteen references must not make the node grow sixteen rows: '+layout.height);
        assert.equal(layout.tops[0],layout.tops[1], 'reference sources share a row at normal node width');
        assert.equal(layout.overflow,false);
        assert.equal(layout.images,16,'all reference slots remain available inside the bounded gallery');
        if (process.env.CAINFLOW_UI_CAPTURE) {
            await mkdir(process.env.CAINFLOW_UI_CAPTURE,{recursive:true});
            const clip=await evaluate("(()=>{const r=document.getElementById('compact-target-reference-sources').closest('.image-reference-overview').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
            const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
            await writeFile(join(process.env.CAINFLOW_UI_CAPTURE,'reference-gallery.png'),Buffer.from(screenshot.data,'base64'));
            await writeFile(join(process.env.CAINFLOW_UI_CAPTURE,'reference-gallery-layout.json'),JSON.stringify(layout,null,2));
        }

        await evaluate("document.querySelector('#compact-target-reference-sources .image-reference-expand').click()");
        assert.ok(await evaluate("document.getElementById('compact-target-reference-sources').offsetHeight<=380"));
        await evaluate("document.querySelector('#compact-target-reference-sources [data-reference-number=\"16\"]').scrollIntoView({block:'nearest'});document.querySelector('#compact-target-reference-sources [data-reference-number=\"16\"]').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"),referenceImages[0]);
        await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
        await waitFor("!document.querySelector('.fullscreen-overlay')");
        await waitFor("document.activeElement.dataset.referenceNumber==='16'");
        await evaluate("document.querySelector('[data-reference-connection=\"compact-edge-15\"] .image-reference-move-up').click()");
        assert.equal(await evaluate("(()=>{const grid=document.querySelector('#compact-target-reference-sources .image-reference-grid'),focus=document.activeElement,r=focus.getBoundingClientRect(),bounds=grid.getBoundingClientRect();return grid.scrollTop>0&&r.top>=bounds.top&&r.bottom<=bounds.bottom})()"),true,'reordering a late source preserves scrolling and leaves the focused source visible');

        await evaluate("document.getElementById('compact-target').style.width='260px'");
        assert.equal(await evaluate("(()=>{const root=document.getElementById('compact-target-reference-sources');return root.scrollWidth<=root.clientWidth+1&&root.offsetHeight<=380})()"),true,'narrow cards wrap without horizontal overflow or unbounded height');

    });
});


test('reordering a legacy reference batch taller than the gallery keeps its focused source visible', {timeout:30000}, async()=>{
    const nodes=[{id:'many',type:'ImageGenerate',x:-800,y:0,apiConfigId:'image',providerId:'p',imageCount:64,imageAssetKey:'legacy-many',imageAssetReady:true},
        {id:'empty',type:'ImageImport',x:-800,y:300}, {id:'target',type:'ImageGenerate',x:100,y:100,apiConfigId:'image',providerId:'p'}];
    const connections=['many','empty'].map((id,order)=>({id:'edge-'+id,from:{nodeId:id,port:'image'},to:{nodeId:'target',port:'referenceImages'},order,type:'image'}));
    await withAppBrowser({...session,nodes,connections},async({evaluate,waitFor})=>{
        await waitFor("document.querySelectorAll('#target-reference-sources [data-reference-number]').length===64");
        assert.equal(await evaluate("document.querySelector('[data-reference-connection=\"edge-many\"]').offsetHeight>document.querySelector('#target-reference-sources .image-reference-grid').clientHeight"),true,'legacy batch placeholders actually exceed the viewport');
        await evaluate("document.querySelector('[data-reference-connection=\"edge-many\"] .image-reference-move-down').click()");
        assert.equal(await evaluate("(()=>{const bounds=document.querySelector('#target-reference-sources .image-reference-grid').getBoundingClientRect(),r=document.activeElement.getBoundingClientRect();return document.activeElement.classList.contains('image-reference-locate')&&r.top>=bounds.top&&r.bottom<=bounds.bottom})()"),true,'a tall source must restore focus to a visible control');
    });
});


test('long generation errors wrap fully inside a narrow image node', {timeout:30000},async()=>{
    await withAppBrowser({...session,nodes:[{id:'error-wrap',type:'ImageGenerate',x:100,y:100,width:300,apiConfigId:'image',providerId:'p',prompt:'test error'}],connections:[]},async app=>{
        const {evaluate,waitFor}=app;await controlImages(app);
        const message='参考图请求失败，请检查供应商配置与上传限制。'.repeat(8)+' request_id='+'x'.repeat(120);
        await evaluate(`window.failImage=true;window.failImageMessage=${JSON.stringify(message)};document.getElementById('error-wrap').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()`);
        await waitFor("!document.querySelector('#error-wrap .node-failure-summary').classList.contains('hidden')");
        const result=await evaluate("(()=>{const el=document.querySelector('#error-wrap .node-failure-summary');return {text:el.textContent,fits:el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1,height:el.clientHeight}})()");
        assert.ok(result.text.includes(message));
        assert.equal(result.fits,true,'full red error text must wrap, including unbroken request identifiers');
        assert.ok(result.height>40,'a long error must occupy multiple visible lines');
    });
});


test('legacy Agent prompt reply preserves references by default and clears them only on explicit request', {timeout:30000},async()=>{
    for (const removeReferences of [false,true]) await withAppBrowser(referenceSession(),async app=>{
        const {evaluate,waitFor}=app;await generateReferenceSources(app);
        await evaluate("window.assistantLegacy=true;window.assistantTargetId='reference-target';document.getElementById('reference-target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click()");
        await change(evaluate,'prompt-agent-input',removeReferences?'@图片生成[reference-target] 不要参考图，画蓝色背景':'@图片生成[reference-target] 把背景改成蓝色');
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        assert.match(await evaluate("document.querySelector('.prompt-agent-plan-inputs').textContent"),removeReferences?/纯文字/:/参考图/);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.some(r=>r.contents)");
        const received=await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.deepEqual(received.map(image=>createHash('sha256').update(image).digest('hex')),(removeReferences?[]:referenceImages).map(image=>createHash('sha256').update(image.split(',')[1]).digest('hex')),'legacy reply follows the human reference request rather than omitted imageRoles');
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"),removeReferences?0:2);
    });
});


test('selected-node optimization keeps active reference order through apply, regenerate, reopen and stale-plan rejection', {timeout:60000},async()=>{
    const seeded=referenceSession({empty:true});seeded.nodes[2].enabled=false;seeded.nodes[3].customTitle='目标生图';
    seeded.connections[0].order=1;seeded.connections[1].order=0;
    await withAppBrowser(seeded,async app=>{
        const {evaluate,waitFor}=app;await generateReferenceSources(app);
        await evaluate("document.getElementById('reference-target').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:500,clientY:120}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();window.assistantTargetId='reference-target';window.assistantEvidence='目标生图'");
        assert.equal(await evaluate("document.getElementById('reference-target').classList.contains('selected')"),true);
        await change(evaluate,'prompt-agent-input','请优化目标生图的提示词，保留参考图');
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const slots=await evaluate("(()=>{const content=imageRequests.find(r=>r.messages).messages.at(-1).content;return JSON.parse(content.find(p=>p.type==='text').text).images.filter(i=>i.connectedToNode).map(i=>[i.sourceNodeId,i.sourceImageIndex])})()");
        assert.deepEqual(slots,[['source-b',0],['source-b',1],['source-a',0],['source-a',1],['source-a',2]]);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await evaluate('imageRequests.filter(r=>r.contents).length'),0,'apply-only never generates');
        const expected=[...referenceImages.slice(3),...referenceImages.slice(0,3)].map(image=>createHash('sha256').update(image.split(',')[1]).digest('hex'));
        const received=()=>evaluate("imageRequests.filter(r=>r.contents).at(-1).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        for(let attempt=1;attempt<=2;attempt++) {
            await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
            await waitFor(`imageRequests.filter(r=>r.contents).length===${attempt} && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')`);
            assert.deepEqual((await received()).map(image=>createHash('sha256').update(image).digest('hex')),expected);
        }
        await delay(1000);await reloadApp(app);
        if(!await evaluate("document.getElementById('prompt-agent-panel').classList.contains('active')")) await evaluate("document.getElementById('btn-prompt-agent').click()");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.filter(r=>r.contents).length===1 && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual((await received()).map(image=>createHash('sha256').update(image).digest('hex')),expected);
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"),3,'disabled source stays connected throughout');
        await evaluate("document.querySelector('[data-reference-connection=\"edge-source-a\"] .image-reference-move-up').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已变化')");
        assert.equal(await evaluate('imageRequests.filter(r=>r.contents).length'),1,'stale plan cannot reorder back or start a request');
        assert.equal(await evaluate("document.querySelector('#reference-target-reference-sources .image-reference-group').dataset.referenceConnection"),'edge-source-a');
    });
});

test('same-pixel references keep all source slots while sharing Agent pixel attachments', {timeout:30000},async()=>{
    await withAppBrowser(referenceSession(),async app=>{
        const {evaluate,waitFor}=app;await generateReferenceSources(app,{samePixels:true});
        await evaluate("window.assistantTargetId='reference-target';document.getElementById('reference-target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const catalog=await evaluate("(()=>{const content=imageRequests.find(r=>r.messages).messages.at(-1).content;return {pixels:content.filter(p=>p.type==='image_url').length,slots:JSON.parse(content.find(p=>p.type==='text').text).images.filter(i=>i.connectedToNode).map(i=>[i.sourceNodeId,i.sourceImageIndex])}})()");
        assert.equal(catalog.pixels,1);
        assert.deepEqual(catalog.slots,[['source-a',0],['source-a',1],['source-a',2],['source-b',0],['source-b',1]]);
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.some(r=>r.contents)");
        const sent=await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.equal(sent.length,5);assert.ok(sent.every(pixels=>pixels===referenceImages[0].split(',')[1]));
    });
});


test('prompt-only followup after applying and compacting a plan retains all reference originals', {timeout:45000},async()=>{
    await withAppBrowser(referenceSession(),async app=>{
        const {evaluate,waitFor}=app;await generateReferenceSources(app);
        await evaluate("window.assistantTargetId='reference-target';document.getElementById('reference-target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存') && !document.getElementById('prompt-agent-input').disabled");
        await evaluate('window.assistantPromptOnly=true');
        await change(evaluate,'prompt-agent-input','只改提示词，让背景更温暖');
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("document.querySelectorAll('.prompt-agent-canvas-plan').length===2");
        const followup=await evaluate("(()=>{const request=imageRequests.filter(r=>r.messages).findLast(r=>{const c=r.messages.at(-1).content;return JSON.parse(Array.isArray(c)?c.find(p=>p.type==='text').text:c).userRequest?.startsWith('只改提示词')});const c=request.messages.at(-1).content;return JSON.parse(c.find(p=>p.type==='text').text).images.filter(i=>i.origins.includes('上一方案参考图')).map(i=>[i.sourceNodeId,i.sourceImageIndex])})()");
        assert.deepEqual(followup,[['source-a',0],['source-a',1],['source-a',2],['source-b',0],['source-b',1]]);
        await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan')].at(-1).querySelectorAll('button').forEach(b=>{if(b.textContent==='应用并执行')b.click()})");
        await waitFor("imageRequests.some(r=>r.contents)");
        const received=await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.deepEqual(received.map(image=>createHash('sha256').update(image).digest('hex')),referenceImages.map(image=>createHash('sha256').update(image.split(',')[1]).digest('hex')));
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"),2,'the previous target retains its original connections');
    });
});

test('Agent can run with every reference source disabled without disconnecting them', {timeout:30000},async()=>{
    const seeded=referenceSession();seeded.nodes[0].enabled=false;seeded.nodes[1].enabled=false;
    await withAppBrowser(seeded,async app=>{
        const {evaluate,waitFor}=app;await controlImages(app);
        await evaluate("window.assistantTargetId='reference-target';document.getElementById('reference-target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.some(r=>r.contents) && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.equal(await evaluate("imageRequests.find(r=>r.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).length"),0);
        assert.equal(await evaluate("document.querySelectorAll('#reference-target-reference-sources .image-reference-group').length"),2);
    });
});


test('partial Agent retries freeze successful upstream originals and full regeneration deliberately refreshes them', {timeout:60000},async()=>{
    await withAppBrowser({...session,nodes:[],connections:[]},async app=>{
        const {evaluate,waitFor}=app;await controlImages(app);
        await evaluate("window.assistantChain=true;window.failChainTarget=true;document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click()");
        await change(evaluate,'prompt-agent-input','先生成主体图，再参考主体图生成成品');
        await evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        await evaluate("document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=google][data-provider-id=p]').click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.filter(r=>r.contents).length===2 && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('未完成') && ![...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').disabled");
        await evaluate("document.querySelector('#modal-error .modal-close')?.click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').click()");
        await waitFor("imageRequests.filter(r=>r.contents).length===3 && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('未完成') && ![...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').disabled");
        const unchanged=await evaluate("imageRequests.filter(r=>r.contents).at(-1).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.deepEqual(unchanged,[png],'retry skipped the successful upstream and used its original pixels');
        const upstream=await evaluate("[...document.querySelectorAll('.node-generate')].find(node=>node.querySelector('textarea[id$=prompt]')?.value==='chain-source').id");
        await evaluate(`window.alternateGeneratedImage=true;document.getElementById('${upstream}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:180}));document.getElementById('context-menu-run-to-here').click()`);
        await waitFor(`imageRequests.filter(r=>r.contents).length===4 && document.getElementById('${upstream}-run-status').textContent==='完成' && document.getElementById('btn-stop').disabled`);
        await evaluate("document.querySelector('#modal-error .modal-close')?.click();[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='重试未完成步骤').click()");
        await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已完成上游')");
        assert.equal(await evaluate('imageRequests.filter(r=>r.contents).length'),4,'changed successful upstream cannot silently enter a partial retry');
        await evaluate("window.failChainTarget=false;[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
        await waitFor("imageRequests.filter(r=>r.contents).length===6 && document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        const refreshed=await evaluate("imageRequests.filter(r=>r.contents).at(-1).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
        assert.deepEqual(refreshed,[referenceImages[4].split(',')[1]],'explicit complete regeneration uses the newly generated upstream');
    });
});
