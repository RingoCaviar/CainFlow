import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';

const originals = Object.fromEntries(await Promise.all(['red', 'blue', 'orange', 'yellow'].map(async color =>
    [color, 'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')])));
const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控来源', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
        { id: 'google', modelId: 'gemini-image', name: '受控目标', protocol: 'google', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
// Durable autosave can take seconds; poll disk at 5Hz without changing its deadline.
const waitForSaved = (app, expression) => app.waitFor(expression, 7500, { interval: 200 });
const generateNode = (id, x, y, extra = {}) => ({ id, type: 'ImageGenerate', x, y, width: 330, height: 300, userResized: true, apiConfigId: 'google', providerId: 'p', prompt: `${id} local draft`, ...extra });

async function controlled(app, reply = { intent: 'chat', message: '已读明确目标' }) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.agentWorkflowRequests=[];window.agentWorkflowReply=${JSON.stringify(reply)};window.agentWorkflowFailNext=false;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(body.messages||body.contents||typeof body.prompt==='string'){agentWorkflowRequests.push(body);if(body.messages)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(agentWorkflowReply)}}]}),{headers:{'Content-Type':'application/json'}});if(body.contents){if(agentWorkflowFailNext){agentWorkflowFailNext=false;return new Response('controlled target failure',{status:500});}return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(originals.yellow.split(',')[1])}}}]}}]}),{headers:{'Content-Type':'application/json'}});}const batches={'legacy-source':['red','blue','red'],'canonical-source':['orange','red'],'duplicate-source':['red','red']},colors=batches[body.prompt]||['red'],count=agentWorkflowRequests.filter(request=>request.prompt===body.prompt).length;return new Response(JSON.stringify({data:[{b64_json:(${JSON.stringify(originals)})[colors[(count-1)%colors.length]].split(',')[1]}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options)};` });
    await reloadAppBrowser(app);
}

async function open(app, id) {
    await app.evaluate(`document.querySelectorAll('.notice-close').forEach(button=>button.click());document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}

async function openAgent(app, id, sources = []) {
    await app.evaluate("if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click()");
    await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
    await change(app, 'prompt-agent-input', '');
    for (const nodeId of [id, ...sources]) {
        await app.evaluate("(()=>{const input=document.getElementById('prompt-agent-input');input.value+='@';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}))})()");
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-node-mentions [role=option]'))");
        await app.evaluate(`(()=>{const option=[...document.querySelectorAll('.prompt-agent-node-mentions [role=option]')].find(button=>button.textContent.endsWith(' · '+${JSON.stringify(nodeId)}));if(!option)throw new Error('Missing mention candidate');option.click()})()`);
    }
    const draft = await app.evaluate("document.getElementById('prompt-agent-input').value");
    await change(app, 'prompt-agent-input', draft + '优化提示词');
}

async function click(app, selector) {
    await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    await app.waitFor(`(()=>{const control=document.querySelector(${JSON.stringify(selector)}),rect=control.getBoundingClientRect();return control.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))})()`);
    let point;
    // Opening Agent and switching results can reflow the image after its pixels decode.
    // Re-read the hit point instead of clicking the coordinates from the old layout.
    for (let attempt = 0; attempt < 30; attempt++) {
        point = await app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await delay(50);
        if (await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`)) break;
    }
    const reachable = await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`);
    const obstruction = reachable ? '' : await app.evaluate(`JSON.stringify({hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,300),target:document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON(),canvas:document.getElementById('canvas-container').getBoundingClientRect().toJSON(),parameters:document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON()})`);
    assert.ok(reachable, `the visible user control is reachable: ${selector} ${obstruction}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function change(app, id, value) {
    await app.evaluate(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function runTo(app, id) {
    const requests = await app.evaluate('agentWorkflowRequests.length');
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:180}));document.getElementById('context-menu-run-to-here').click()`);
    await app.waitFor(`agentWorkflowRequests.length>${requests}&&document.getElementById(${JSON.stringify(id+'-run-status')})?.dataset.status==='completed'&&document.getElementById('btn-stop').disabled`);
}

async function chooseModel(app, purpose, model) {
    const id = purpose === 'chat' ? 'prompt-agent-model' : 'prompt-agent-image-model';
    await app.evaluate(`document.querySelector('#${id} + button').click();document.querySelector('#${id}-menu [data-model-id=${model}][data-provider-id=p]').click()`);
}

async function planAction(app, label) {
    if (['运行', '重试未完成步骤'].includes(label)) await waitForAutosave(app);
    await app.waitFor(`(()=>{const buttons=[...document.querySelectorAll('.prompt-agent-canvas-plan')].at(-1)?.querySelectorAll('.prompt-agent-canvas-actions button');return [...(buttons||[])].some(button=>button.textContent===${JSON.stringify(label)}&&!button.disabled)})()`);
    await app.evaluate(`(()=>{const buttons=[...document.querySelectorAll('.prompt-agent-canvas-plan')].at(-1)?.querySelectorAll('.prompt-agent-canvas-actions button'),button=[...(buttons||[])].find(button=>button.textContent===${JSON.stringify(label)});if(!button)throw new Error('Missing plan action: '+${JSON.stringify(label)});button.click()})()`);
}

async function history(app, key, feedback) {
    await app.evaluate(`(()=>{window.agentWorkflowHistory=false;const observer=new MutationObserver(records=>{if(records.some(record=>Array.from(record.addedNodes).some(node=>node.textContent?.includes(${JSON.stringify(feedback)})))){agentWorkflowHistory=true;observer.disconnect()}});observer.observe(document.getElementById('toast-container'),{childList:true,subtree:true});document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    await app.waitFor('agentWorkflowHistory===true');
}

async function attach(app, name = 'retained.png') {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(originals.blue)})).blob()],${JSON.stringify(name)},{type:'image/png'}));document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
    await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===1&&!document.querySelector('#prompt-agent-references .is-loading')");
}

async function chatInput(app) {
    return app.evaluate("(()=>{const content=agentWorkflowRequests.find(request=>request.messages).messages.at(-1).content;return JSON.parse(Array.isArray(content)?content.find(part=>part.type==='text').text:content)})()");
}

const choiceButtons = '.prompt-agent-choices button';
const enabledChoice = index => `${choiceButtons}:nth-of-type(${index}):not(:disabled)`;
const enabledChoiceLabels = app => app.evaluate(`[...document.querySelectorAll('${choiceButtons}:not(:disabled)')].map(button => button.textContent.trim())`);
const latestUserText = "[...document.querySelectorAll('.prompt-agent-message-user .prompt-agent-message-body')].at(-1)?.textContent";
const creativePlan = (title, prompt, taskUpdate) => ({ intent: 'generate', message: title, taskUpdate,
    canvasPlan: { version: 1, steps: [{ id: 'generate', type: 'ImageGenerate', title, parameters: { prompt } }], connections: [] } });
const agentSnapshot = app => app.evaluate("import('/js/app/bootstrap.js').then(module => module.bootstrapCainFlowApp()).then(app => app.registry.promptAgentController.snapshotWorkflow())");

async function answerWithConfirmationThenPlan(app, plan) {
    const confirmation = { intent: 'clarify', message: '是否开始新任务？', taskUpdate: { mode: 'new' } };
    await app.evaluate(`(() => {
        const first = agentWorkflowRequests.length + 1;
        Object.defineProperty(window, 'agentWorkflowReply', {
            configurable: true,
            get: () => agentWorkflowRequests.length === first ? ${JSON.stringify(confirmation)} : ${JSON.stringify(plan)}
        });
    })()`);
}

async function sendAgentMessage(app, text) {
    await change(app, 'prompt-agent-input', text);
    await app.evaluate("document.getElementById('prompt-agent-form').requestSubmit()");
}

test('clarification choice survives refresh, submits as a user answer and preserves the draft', { timeout: 45000 }, async () => {
    const question = '海报用哪种构图？';
    const choices = ['竖向构图', '横向构图'];
    const draft = '这段草稿稍后再发';
    await withAppBrowser(configuration, async app => {
        await controlled(app, { intent: 'clarify', message: question, choices });
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await chooseModel(app, 'chat', 'chat');
        await sendAgentMessage(app, '设计一张海报');
        await app.waitFor(`document.querySelectorAll('${choiceButtons}:not(:disabled)').length===2`);
        assert.deepEqual(await enabledChoiceLabels(app), choices);

        await change(app, 'prompt-agent-input', draft);
        await reloadAppBrowser(app);
        await app.evaluate("if (!document.getElementById('prompt-agent-panel').classList.contains('active')) document.getElementById('btn-prompt-agent').click()");
        await app.waitFor(`document.querySelectorAll('${choiceButtons}:not(:disabled)').length===2`);
        assert.deepEqual(await enabledChoiceLabels(app), choices);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), draft);

        const response = '收到横向构图。';
        await app.evaluate(`agentWorkflowReply=${JSON.stringify({ intent: 'chat', message: response })}`);
        await click(app, enabledChoice(2));
        await app.waitFor(`document.querySelector('#prompt-agent-messages').textContent.includes(${JSON.stringify(response)}) && document.getElementById('prompt-agent-cancel').hidden`);
        assert.equal(await app.evaluate(latestUserText), choices[1]);
        const input = await chatInput(app);
        assert.equal(input.userRequest, choices[1]);
        assert.deepEqual(input.choiceAnswer, { question, choice: choices[1] });
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), draft);
        assert.equal(await app.evaluate('agentWorkflowRequests.length'), 1);
        assert.deepEqual(await enabledChoiceLabels(app), []);
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-message-user')].at(-1).querySelector('[data-message-action=resend]').click()");
        await app.waitFor("agentWorkflowRequests.length===2 && document.getElementById('prompt-agent-cancel').hidden");
        const resent = await app.evaluate("JSON.parse(agentWorkflowRequests.at(-1).messages.at(-1).content)");
        assert.deepEqual(resent.choiceAnswer, input.choiceAnswer, 'resending an answer retains its question');
    });
});

test('a clear standalone creative task drafts a new canvas plan directly without inheriting the old dimensions', async () => {
    const cupRequest = '生成2K、16:9的白色杯子';
    const stadiumRequest = '生成一张4K的黑夜里的足球场照片';
    await withAppBrowser({ ...configuration, nodes: [], connections: [] }, async app => {
        await controlled(app, creativePlan('白杯方案', '白色杯子'));
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await chooseModel(app, 'chat', 'chat');
        await sendAgentMessage(app, cupRequest);
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan') && document.getElementById('prompt-agent-cancel').hidden");
        const cup = await agentSnapshot(app);
        assert.deepEqual(cup.creativeTask.parameters, { resolution: '2K', aspectRatio: '16:9' });

        const stadiumReply = creativePlan('足球场方案', '夜里的足球场', {
            mode: 'new', parameters: { resolution: { value: '4K', evidence: '4K' } }
        });
        await answerWithConfirmationThenPlan(app, stadiumReply);
        await sendAgentMessage(app, stadiumRequest);
        await app.waitFor("agentWorkflowRequests.length>=2 && document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate(`document.querySelectorAll('${choiceButtons}').length`), 0);
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length"), 2);

        const stadium = await agentSnapshot(app);
        const plan = stadium.messages.at(-1).canvasPlan;
        assert.deepEqual(stadium.messages.map(message => message.text), [cupRequest, '白杯方案', stadiumRequest, '足球场方案']);
        assert.notEqual(stadium.creativeTask.id, cup.creativeTask.id);
        assert.deepEqual(stadium.creativeTask.parameters, { resolution: '4K' });
        assert.deepEqual(stadium.messages[1].canvasPlan, cup.messages[1].canvasPlan);
        assert.equal(plan.taskId, stadium.creativeTask.id);
        assert.equal(plan.newCreativeTask, true);
        assert.equal(plan.steps[0].nodeId, undefined);
        assert.equal(plan.steps[0].parameters.prompt, '夜里的足球场');
        assert.equal(plan.steps[0].parameters.resolution, '4K');
        assert.equal(plan.steps[0].parameters.aspect, undefined);
        assert.equal(stadium.messages.at(-1).runs?.length || 0, 0);
        assert.deepEqual(await app.evaluate("agentWorkflowRequests.map(request => request.messages && JSON.parse(request.messages.at(-1).content).userRequest)"),
            [cupRequest, stadiumRequest, stadiumRequest]);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer > .node').length"), 0);
    });
});

test('an attached edit skips the generic confirmation and plans against its image instead of the selected generator', async () => {
    await withAppBrowser({ ...configuration, nodes: [generateNode('unrelated', 40, 120)], connections: [] }, async app => {
        await controlled(app, creativePlan('球场方案', '夜间足球场'));
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await chooseModel(app, 'chat', 'chat');
        await sendAgentMessage(app, '生成一张夜间足球场照片');
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan') && document.getElementById('prompt-agent-cancel').hidden");

        await attach(app, '杯子.png');
        await open(app, 'unrelated');
        const request = '把这个杯子上的旧图案和文字都去掉，然后换成小海豹图案，品牌名叫 CAIN';
        const prompt = '移除原图案和文字，换成小海豹图案和 CAIN 标志';
        await answerWithConfirmationThenPlan(app, {
            intent: 'edit', message: '杯子修改方案', taskUpdate: { mode: 'new' },
            targetSelection: { mode: 'explicit', imageId: 'image-1', evidence: '这个杯子' },
            promptPlan: { prompt, imageRoles: [{ imageId: 'image-1', role: 'edit-target' }] }
        });
        await sendAgentMessage(app, request);
        await app.waitFor("agentWorkflowRequests.length>=2 && document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate(`document.querySelectorAll('${choiceButtons}').length`), 0);
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length"), 2);
        const snapshot = await agentSnapshot(app);
        const [userTurn, reply] = snapshot.messages.slice(2);
        assert.deepEqual(snapshot.messages.slice(2).map(message => message.text), [request, '杯子修改方案']);
        const [reference] = userTurn.referenceImages;
        assert.equal(reference.name, '杯子.png');
        const generator = reply.canvasPlan.steps.find(step => step.type === 'ImageGenerate');
        assert.equal(generator.nodeId, undefined);
        assert.equal(generator.parameters.prompt, prompt);
        assert.equal(reply.canvasPlan.connections.find(link => link.to.ref === generator.id).from.ref, reference.sourceNodeId);
        const inputs = await app.evaluate("agentWorkflowRequests.slice(1).map(request => JSON.parse(request.messages.at(-1).content[0].text))");
        assert.deepEqual(inputs.map(input => [input.userRequest, input.canvas.selectedIds]), [[request, ['unrelated']], [request, ['unrelated']]]);
        assert.equal(await app.evaluate("document.getElementById('unrelated-prompt').value"), 'unrelated local draft');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer > .node').length"), 2);
    });
});

test('confirming an ambiguous creative task produces a fresh canvas plan without running it', async () => {
    await withAppBrowser({ ...configuration, nodes: [generateNode('unrelated', 40, 120)], connections: [] }, async app => {
        await controlled(app, creativePlan('白杯方案', '白色杯子'));
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await chooseModel(app, 'chat', 'chat');
        await sendAgentMessage(app, '生成白色杯子');
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan') && document.getElementById('prompt-agent-cancel').hidden");

        const request = '再来一张，换个方向';
        const clarification = { intent: 'clarify', message: '是否开始新任务？', taskUpdate: { mode: 'new' } };
        const askForNewTask = async () => {
            await app.evaluate(`agentWorkflowReply=${JSON.stringify(clarification)}`);
            await sendAgentMessage(app, request);
            await app.waitFor(`document.querySelectorAll('${choiceButtons}:not(:disabled)').length===2 && document.getElementById('prompt-agent-cancel').hidden`);
            assert.deepEqual(await enabledChoiceLabels(app), ['是', '否']);
            assert.match(await app.evaluate("document.querySelector('#prompt-agent-messages').textContent"), /请确认是否开始新的创作任务/);
        };
        await askForNewTask();
        await click(app, enabledChoice(2));
        await app.waitFor("document.querySelector('#prompt-agent-messages').textContent.includes('已保留当前创作任务。')");
        assert.equal(await app.evaluate(latestUserText), '否');
        assert.equal(await app.evaluate('agentWorkflowRequests.length'), 2, 'declining the reset does not call a model');
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length"), 1);
        assert.deepEqual(await enabledChoiceLabels(app), []);

        await askForNewTask();
        assert.equal(await app.evaluate(`document.querySelectorAll('${choiceButtons}:disabled').length`), 2);
        await open(app, 'unrelated');
        await app.evaluate(`agentWorkflowReply=${JSON.stringify(creativePlan('夜景方案', '夜间街景', { mode: 'new' }))}`);
        await click(app, enabledChoice(1));
        await app.waitFor("document.querySelectorAll('.prompt-agent-canvas-plan').length===2 && document.getElementById('prompt-agent-cancel').hidden");

        assert.equal(await app.evaluate(latestUserText), '是');
        assert.deepEqual(await enabledChoiceLabels(app), []);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.prompt-agent-step-title')].map(title=>title.textContent)"), ['白杯方案', '夜景方案']);
        const requests = await app.evaluate("agentWorkflowRequests.map(request => request.messages && JSON.parse(request.messages.at(-1).content))");
        assert.deepEqual(requests.map(input => input?.userRequest), ['生成白色杯子', request, request, request]);
        assert.deepEqual(requests.map(input => input.confirmedNewTask), [undefined, undefined, undefined, true]);
        assert.deepEqual(requests.at(-1).canvas.selectedIds, [], 'confirmation does not target a node selected after the original request');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer > .node').length"), 1);
    });
});

test('two result slots with identical original bytes stage separately while repeating the same slot stays idempotent', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        generateNode('duplicate-source', 40, 100, { apiConfigId: 'image', prompt: 'duplicate-source', generationCount: 2 }),
        { id: 'sink', type: 'ImagePreview', x: 600, y: 100 }
    ], connections: [{ id: 'whole-batch', from: { nodeId: 'duplicate-source', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' }] }, async app => {
        await controlled(app); await runTo(app, 'duplicate-source');
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='duplicate-source')?.mediaAssetKeys?.length===2)");
        const original = await saved(app), keys = original.nodes.find(node => node.id === 'duplicate-source').mediaAssetKeys;
        assert.equal(keys[0], keys[1], 'the distinct batch slots really share one durable original');
        await open(app, 'duplicate-source');
        // Bottom-clamped editors may cover the card's result toolbar.
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await click(app, '#duplicate-source-image-results [data-result-action=reference]');
        await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===1&&!document.querySelector('#prompt-agent-references .is-loading')");
        await app.evaluate("document.querySelector('#duplicate-source-image-results [data-result-step=\"-1\"]').click()");
        await app.waitFor("document.querySelector('#duplicate-source-image-results .image-node-result-count').textContent==='1 / 2'");
        await click(app, '#duplicate-source-image-results [data-result-action=reference]');
        await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===2&&!document.querySelector('#prompt-agent-references .is-loading')");
        await click(app, '#duplicate-source-image-results [data-result-action=reference]');
        await delay(100);
        assert.equal(await app.evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 2);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#prompt-agent-references img')].map(image=>image.src)"), [originals.red, originals.red]);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), '');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-image-model').value"), '');
        const after = await saved(app);
        assert.deepEqual(after.nodes.find(node => node.id === 'duplicate-source').mediaAssetKeys, keys);
        assert.deepEqual(after.connections, original.connections);
        assert.equal(await app.evaluate('agentWorkflowRequests.length'), 2, 'preparing either result never sends another request');
    });
});

test('mixed legacy and canonical full-batch references preserve slot identities and exact edges through apply, undo, retry, regeneration, reload and stale rejection', { timeout: 90000 }, async () => {
    const connections = [
        { id: 'canonical-edge', from: { nodeId: 'canonical-source', port: 'image', extension: { side: 'from-B' } }, to: { nodeId: 'target', port: 'referenceImages', extension: { side: 'to-B' } }, type: 'image', order: 44, extension: { keep: ['B', 2] } },
        { id: 'disabled-edge', from: { nodeId: 'disabled-source', port: 'image' }, to: { nodeId: 'target', port: 'image_7' }, type: 'image', order: 1, extension: { disabledStillConnected: true } },
        { id: 'legacy-edge', from: { nodeId: 'legacy-source', port: 'image', extension: { side: 'from-A' } }, to: { nodeId: 'target', port: 'image_10', extension: { side: 'to-A' } }, type: 'image', order: 12, extension: { keep: ['A', 3] } }
    ];
    // The established document adapter migrates legacy generation inputs to
    // referenceImages; explicit ordering and the complete edge identity remain.
    const canonicalConnections = connections.map(edge => ({ ...edge, to: { ...edge.to, port: 'referenceImages' } }));
    const reply = { intent: 'generate', message: '保留全部来源，只修改明确目标提示词', canvasPlan: { version: 1,
        steps: [{ id: 'revise', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'mixed references revised prompt' } }],
        connections: ['disabled-source', 'legacy-source', 'canonical-source'].map((source, order) => ({ from: { ref: source, port: 'image' }, to: { ref: 'revise', port: 'referenceImages' }, type: 'image', order, evidence: '保留全部参考来源及其顺序' }))
    } };
    await withAppBrowser({ ...configuration, nodes: [
        generateNode('legacy-source', -500, 80, { apiConfigId: 'image', prompt: 'legacy-source', generationCount: 3 }),
        generateNode('canonical-source', -500, 500, { apiConfigId: 'image', prompt: 'canonical-source', generationCount: 2 }),
        { id: 'disabled-source', type: 'ImageImport', x: -500, y: 900, enabled: false },
        generateNode('target', 390, 80, { customTitle: '混合来源目标', aspect: '16:9', resolution: '2K' }),
        generateNode('unrelated', 900, 80)
    ], connections }, async app => {
        await controlled(app, reply);
        await runTo(app, 'legacy-source'); await runTo(app, 'canonical-source');
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='legacy-source')?.mediaAssetKeys?.length===3&&document.value?.nodes.find(node=>node.id==='canonical-source')?.mediaAssetKeys?.length===2)");
        const original = await saved(app), keys = id => original.nodes.find(node => node.id === id).mediaAssetKeys;
        assert.deepEqual(original.connections, canonicalConnections);
        assert.equal(keys('legacy-source')[0], keys('legacy-source')[2]);
        assert.equal(keys('canonical-source')[1], keys('legacy-source')[0]);
        await open(app, 'target'); await openAgent(app, 'target');
        await chooseModel(app, 'chat', 'chat');
        await change(app, 'prompt-agent-input', '@混合来源目标[target] 优化提示词并保留全部参考来源及其顺序');
        await open(app, 'unrelated');
        const partialReply = { ...reply, canvasPlan: { ...reply.canvasPlan, connections: reply.canvasPlan.connections.slice(1) } };
        await app.evaluate(`agentWorkflowReply=${JSON.stringify(partialReply)}`);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor("agentWorkflowRequests.filter(request=>request.messages).length===1&&document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length"), 0, 'omitting a disabled retained source does not authorize clearing its edge');
        assert.match(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /断开已有参考图|保留参考图/);
        assert.deepEqual((await saved(app)).connections, canonicalConnections);
        await app.evaluate(`agentWorkflowReply=${JSON.stringify(reply)}`);
        await change(app, 'prompt-agent-input', '@混合来源目标[target] 优化提示词并保留全部参考来源及其顺序');
        await app.evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const input = await chatInput(app), catalog = input.images.filter(image => image.connectedToNode);
        assert.equal(input.currentNode.nodeId, 'target');
        assert.deepEqual(catalog.map(image => [image.sourceNodeId, image.sourceImageIndex]), [['legacy-source', 0], ['legacy-source', 1], ['legacy-source', 2], ['canonical-source', 0], ['canonical-source', 1]]);
        assert.equal(new Set(catalog.map(image => image.imageId)).size, 5, 'same-byte images retain five distinct source slots in the actual Agent catalog');
        assert.equal(await app.evaluate("agentWorkflowRequests.find(request=>request.messages).messages.at(-1).content.filter(part=>part.type==='image_url').length"), 3, 'only the transport pixels are deduplicated');
        assert.equal(await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(button=>button.textContent==='仅应用').disabled"), true, 'the hand-selected target model is still required');
        await chooseModel(app, 'image', 'google'); await planAction(app, '仅应用');
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.filter(n=>n.prompt==='mixed references revised prompt').length===1)");
        const applied = await saved(app);
        const copy = applied.nodes.find(node=>node.prompt==='mixed references revised prompt');
        assert.notEqual(copy.id,'target');
        assert.equal(applied.nodes.find(node=>node.id==='target').prompt,'target local draft');
        assert.deepEqual(applied.connections.filter(edge=>connections.some(old=>old.id===edge.id)),canonicalConnections,'original edges and metadata remain unchanged');
        assert.deepEqual(applied.connections.filter(edge=>edge.to.nodeId===copy.id).map(edge=>edge.from.nodeId),['disabled-source','legacy-source','canonical-source']);
        assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'),0);
        await planAction(app,'仅应用');
        await app.waitFor("!document.querySelector('.prompt-agent-actions-primary .btn-primary').disabled");
        await waitForSaved(app, `fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.length===${applied.nodes.length+1})`);
        await history(app,'z','已撤回');
        await waitForSaved(app, `fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.length===${applied.nodes.length})`);
        assert.deepEqual((await saved(app)).connections,applied.connections,'undo removes only the latest batch');
        await history(app,'y','已重做');
        await waitForSaved(app, `fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.length===${applied.nodes.length+1})`);
        assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'),0,'redo never executes');
        const expected = [originals.red, originals.blue, originals.red, originals.orange, originals.red].map(image => image.split(',')[1]);
        await app.evaluate('agentWorkflowFailNext=true'); await planAction(app, '运行');
        await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===1&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('未完成')");
        await app.evaluate("document.querySelector('#modal-error .modal-close')?.click()");
        await planAction(app, '重试未完成步骤');
        await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===2&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        await planAction(app, '运行');
        await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===3&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        const sent = await app.evaluate("agentWorkflowRequests.filter(request=>request.contents).map(request=>({pixels:request.contents.flatMap(content=>content.parts).filter(part=>part.inlineData).map(part=>part.inlineData.data),size:request.generationConfig.imageConfig}))");
        for (const request of sent) {
            assert.deepEqual(request.pixels, expected);
            assert.equal(request.size.aspectRatio, '16:9'); assert.equal(request.size.imageSize, '2K');
        }
        assert.equal(await app.evaluate("agentWorkflowRequests.filter(request=>typeof request.prompt==='string').length"), 5, 'fixed source batches are never regenerated by target retries or regeneration');
        for (const id of ['legacy-source', 'canonical-source']) assert.deepEqual((await saved(app)).nodes.find(node => node.id === id).mediaAssetKeys, keys(id));

        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.workflowTabs?.every(tab=>!tab.dirty))");
        const owners = await app.evaluate("(async()=>{const graph=(await fetch('/api/storage/documents/session').then(response=>response.json())).value;return (await fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(graph.activeWorkflowId)).then(response=>response.json())).owners})()");
        for (const id of ['legacy-source', 'canonical-source']) {
            const owner = owners.find(owner => owner.ownerType === 'workflow-node' && owner.ownerId === id);
            assert.ok(owner && keys(id).every(key => owner.assetKeys.includes(key)), 'Agent graph operations retain ownership of every complete source batch');
        }
        const beforeReload = await saved(app);
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const restored = await saved(app);
        assert.deepEqual(restored.connections, beforeReload.connections);
        for (const id of ['legacy-source', 'canonical-source']) assert.deepEqual(restored.nodes.find(node => node.id === id).mediaAssetKeys, keys(id));
        await planAction(app, '运行');
        await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===1&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        assert.deepEqual(await app.evaluate("agentWorkflowRequests.find(request=>request.contents).contents.flatMap(content=>content.parts).filter(part=>part.inlineData).map(part=>part.inlineData.data)"), expected);
        await open(app, 'target');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=more]').click();document.querySelector('[data-reference-connection=legacy-edge] .image-reference-thumbnail').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true}))");
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections.find(edge=>edge.id==='legacy-edge').order>document.value.connections.find(edge=>edge.id==='canonical-edge').order)");
        const reordered = await saved(app);
        await planAction(app, '运行');
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已变化')");
        assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'), 1);
        assert.deepEqual((await saved(app)).connections, reordered.connections, 'stale rejection does not silently undo the user source ordering');
    });
});

test('optimization previews and changes the real Text prompt source while derived Camera input is explicitly read-only and cannot be bypassed through the local draft', { timeout: 90000 }, async () => {
    for (const type of ['Text', 'CameraControl']) {
        const source = { id: 'prompt-source', type, x: 20, y: 90, customTitle: type === 'Text' ? '真实文字来源' : '只读视角来源',
            ...(type === 'Text' ? { text: 'original effective upstream text' } : { pitch: 15, yaw: 32, distance: 7.5, fov: 62, roll: -4 }) };
        const connection = { id: 'retained-prompt-source', from: { nodeId: source.id, port: 'text', extension: { source: true } }, to: { nodeId: 'target', port: 'prompt', extension: { target: true } }, type: 'text', extension: { retain: ['effective', 'source'] } };
        const reply = { intent: 'generate', message: type === 'Text' ? '明确修改真实文字来源，保留目标连接及本地草稿' : '尝试只修改目标本地稿', canvasPlan: { version: 1, steps: type === 'Text' ? [
            { id: 'edit-source', type: 'Text', nodeId: source.id, parameters: { text: 'optimized real upstream text' } },
            { id: 'use-source', type: 'ImageGenerate', nodeId: 'target', parameters: {} }
        ] : [{ id: 'bad-local', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'must never become a false local optimization' } }], connections: [] } };
        await withAppBrowser({ ...configuration, nodes: [source, generateNode('target', 430, 90, { customTitle: '真实输入目标', prompt: 'ineffective local draft' }), generateNode('unrelated', 900, 90)], connections: [connection] }, async app => {
            await controlled(app, reply); await open(app, 'target');
            assert.equal(await app.evaluate("document.getElementById('target-prompt').readOnly"), true);
            await openAgent(app, 'target', type === 'Text' ? ['prompt-source'] : []);
            const draft = await app.evaluate("document.getElementById('prompt-agent-input').value"), before = await saved(app), originalSource = before.nodes.find(node => node.id === source.id);
            assert.match(draft, /\[target\]/);
            if (type === 'Text') {
                assert.match(draft, /\[prompt-source\]/, 'the user can review explicit authorization for both the target and its real editable source');
                assert.match(await app.evaluate("document.getElementById('prompt-agent-node-context').textContent"), /真实文字来源/);
            } else {
                assert.ok(!draft.includes('[prompt-source]'), 'the derived source is never implicitly authorized for mutation');
                assert.match(await app.evaluate("document.getElementById('prompt-agent-node-context').textContent"), /只读.*视角|视角.*只读/);
            }
            await chooseModel(app, 'chat', 'chat');
            await open(app, 'unrelated');
            await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
            await app.waitFor("agentWorkflowRequests.filter(request=>request.messages).length===1&&document.getElementById('prompt-agent-cancel').hidden");
            const input = await chatInput(app);
            assert.equal(input.currentNode.nodeId, 'target');
            assert.equal(input.currentNode.prompt, type === 'Text' ? source.text : originalSource.cameraPrompt, 'the actual Agent sees the effective source prompt rather than the inactive local draft');
            if (type === 'CameraControl') {
                assert.equal(await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].some(button=>['仅应用','运行','运行'].includes(button.textContent)&&!button.disabled)"), false, 'the read-only source cannot be bypassed by a successful-looking local prompt plan');
                const rejected = await saved(app);
                assert.equal(rejected.nodes.find(node => node.id === 'target').prompt, 'ineffective local draft');
                assert.deepEqual(rejected.connections, before.connections);
                assert.deepEqual(rejected.nodes.find(node => node.id === source.id), originalSource);
                assert.equal(await app.evaluate('agentWorkflowRequests.length'), 1);
                return;
            }
            await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
            assert.match(await app.evaluate("document.querySelector('.prompt-agent-canvas-plan').textContent"), /真实文字来源/);
            await chooseModel(app, 'image', 'google'); await planAction(app, '仅应用');
            await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id!=='prompt-source'&&node.text==='optimized real upstream text')?.text==='optimized real upstream text')");
            const applied = await saved(app);
            assert.equal(applied.nodes.find(node => node.id === 'target').prompt, 'ineffective local draft');
            assert.deepEqual(applied.connections.filter(edge => edge.id === connection.id), before.connections);
            assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'), 0);
            await planAction(app, '运行');
            await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===1&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
            const sent = await app.evaluate("agentWorkflowRequests.find(request=>request.contents).contents.flatMap(content=>content.parts).filter(part=>part.text).map(part=>part.text).join('\\n')");
            assert.ok(sent.includes('optimized real upstream text'));
            assert.ok(!sent.includes('ineffective local draft'));
            const results = await app.evaluate("document.querySelectorAll('.prompt-agent-result-image').length");
            assert.ok(results > 0);
            await planAction(app, '撤销本次画布操作');
            await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent==='已按撤销栈处理；历史图片仍保留'");
            await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='prompt-source')?.text==='original effective upstream text')");
            assert.deepEqual((await saved(app)).connections, applied.connections);
            assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-result-image').length"), results, 'Agent media survives undo of its graph application');
            await history(app, 'y', '已重做');
            await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id!=='prompt-source'&&node.text==='optimized real upstream text')?.text==='optimized real upstream text')");
            assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'), 1);

            await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.workflowTabs?.every(tab=>!tab.dirty))");
            const beforeReload = await saved(app);
            await reloadAppBrowser(app);
            const restored = await saved(app);
            assert.equal(restored.nodes.find(node => node.id === 'prompt-source').text, 'original effective upstream text');
            assert.ok(restored.nodes.some(node=>node.id!=='prompt-source'&&node.text==='optimized real upstream text'));
            assert.equal(restored.nodes.find(node => node.id === 'target').prompt, 'ineffective local draft');
            assert.deepEqual(restored.connections, beforeReload.connections);
            assert.equal(await app.evaluate('agentWorkflowRequests.length'), 0);
        });
    }
});

test('an explicit request can atomically disconnect the prompt source and use a new local draft, with one undo and execution-free redo', { timeout: 45000 }, async () => {
    const edge = { id: 'explicit-prompt-input', from: { nodeId: 'switch-source', port: 'text', extension: { source: 'retained' } }, to: { nodeId: 'switch-target', port: 'prompt', extension: { target: 'retained' } }, type: 'text', extension: { preserveOnUndo: true } };
    const reply = { intent: 'generate', message: '明确断开提示词输入并改用本地提示词', canvasPlan: { version: 1,
        steps: [{ id: 'use-local', type: 'ImageGenerate', nodeId: 'switch-target', parameters: { prompt: 'new explicitly authorized local prompt' } }],
        disconnects: [{ ref: 'use-local', port: 'prompt' }], connections: []
    } };
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'switch-source', type: 'Text', x: 20, y: 100, customTitle: '仍须保留的文字源', text: 'the original upstream text remains untouched' },
        generateNode('switch-target', 430, 100, { customTitle: '切换目标', prompt: 'old local draft retained behind input' })
    ], connections: [edge] }, async app => {
        await controlled(app, reply); await open(app, 'switch-target');
        await openAgent(app, 'switch-target');
        await change(app, 'prompt-agent-input', '断开提示词输入 @切换目标[switch-target]，改用本地提示词');
        await chooseModel(app, 'chat', 'chat');
        await app.evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
        const before = await saved(app);
        assert.deepEqual(before.connections, [edge]);
        assert.equal(before.nodes.find(node => node.id === 'switch-target').prompt, 'old local draft retained behind input');
        await chooseModel(app, 'image', 'google');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await planAction(app, '仅应用');
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id!=='switch-target'&&node.prompt==='new explicitly authorized local prompt')?.prompt==='new explicitly authorized local prompt')");
        const applied = await saved(app);
        assert.equal(applied.nodes.find(node => node.id === 'switch-source').text, 'the original upstream text remains untouched');
        assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'), 0, 'applying the input change does not execute');
        await history(app, 'z', '已撤回');
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='switch-target')?.prompt==='old local draft retained behind input'&&document.value.connections.some(edge=>edge.id==='explicit-prompt-input'))");
        const undone = await saved(app);
        assert.deepEqual(undone.connections, before.connections, 'one undo restores the complete original edge including endpoint metadata');
        assert.equal(undone.nodes.length, before.nodes.length);
        assert.equal(undone.nodes.find(node => node.id === 'switch-source').text, 'the original upstream text remains untouched');
        await history(app, 'y', '已重做');
        await waitForSaved(app, "fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id!=='switch-target'&&node.prompt==='new explicitly authorized local prompt')?.prompt==='new explicitly authorized local prompt')");
        assert.deepEqual((await saved(app)).connections, applied.connections);
        assert.equal(await app.evaluate('agentWorkflowRequests.filter(request=>request.contents).length'), 0, 'redo restores only the graph');
        await planAction(app, '运行');
        await app.waitFor("agentWorkflowRequests.filter(request=>request.contents).length===1&&document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
        const prompt = await app.evaluate("agentWorkflowRequests.find(request=>request.contents).contents.flatMap(content=>content.parts).filter(part=>part.text).map(part=>part.text).join('\\n')");
        assert.ok(prompt.includes('new explicitly authorized local prompt'));
        assert.ok(!prompt.includes('the original upstream text remains untouched'));
        const after = await saved(app);
        assert.equal(after.nodes.find(node => node.id === 'switch-source').text, 'the original upstream text remains untouched');
        assert.deepEqual(after.connections.filter(connection=>connection.to.nodeId==='switch-target'),[edge]);
        const copies=after.nodes.filter(node=>node.id!=='switch-target'&&node.prompt==='new explicitly authorized local prompt');
        assert.ok(copies.length===2&&copies.every(node=>!after.connections.some(edge=>edge.to.nodeId===node.id&&edge.to.port==='prompt')));
    });
});


test('editing prompt prose cannot authorize an Agent proposal to disconnect its effective upstream source', { timeout: 45000 }, async () => {
    const edge = { id: 'kept-prompt', from: { nodeId: 'source', port: 'text', extra: { keep: true } },
        to: { nodeId: 'target', port: 'prompt' }, type: 'text', order: 9, extension: { keep: ['the source', 'and order'] } };
    const reply = { intent: 'generate', message: '尝试断开来源并改写本地稿', canvasPlan: { version: 1,
        steps: [{ id: 'generate', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'must never replace the source' } }],
        disconnects: [{ ref: 'generate', port: 'prompt' }], connections: [] } };
    for (const request of ['清除提示词中的水印描述', '替换提示词为蓝色背景']) {
        await withAppBrowser({ ...configuration, nodes: [
            { id: 'source', type: 'Text', x: 20, y: 100, text: 'actual upstream prompt with watermark wording' },
            generateNode('target', 430, 100, { customTitle: '输入目标', prompt: 'unchanged inactive draft' })
        ], connections: [edge] }, async app => {
            await controlled(app, reply); await open(app, 'target');
            const before = await saved(app);
            await openAgent(app, 'target'); await chooseModel(app, 'chat', 'chat');
            await change(app, 'prompt-agent-input', '@输入目标[target] ' + request);
            await app.evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
            await app.waitFor("agentWorkflowRequests.filter(request=>request.messages).length===1&&document.getElementById('prompt-agent-cancel').hidden");
            assert.equal(await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].some(button=>['仅应用','运行','运行'].includes(button.textContent)&&!button.disabled)"), false);
            const after = await saved(app);
            assert.deepEqual(after.connections, before.connections, 'the malicious proposed disconnect never reaches the real graph');
            assert.equal(after.nodes.find(node => node.id === 'source').text, before.nodes.find(node => node.id === 'source').text);
            assert.equal(after.nodes.find(node => node.id === 'target').prompt, 'unchanged inactive draft');
            assert.equal(await app.evaluate('agentWorkflowRequests.length'), 1, 'no image generation is triggered');
        });
    }
});
