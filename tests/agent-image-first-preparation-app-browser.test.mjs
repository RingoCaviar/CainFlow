import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser } from './helpers/app-browser.mjs';

const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'Text', x: -600, y: 40, customTitle: '真实产品提示词', text: '上游的有效产品描述' },
        { id: 'first', type: 'ImageGenerate', x: 80, y: 40, width: 420, height: 220, userResized: true, customTitle: '产品画面', apiConfigId: 'image', providerId: 'p', prompt: '无效的本地草稿' },
        { id: 'second', type: 'ImageGenerate', x: 600, y: 40, width: 420, height: 220, userResized: true, customTitle: '另一个画面', apiConfigId: 'image', providerId: 'p', prompt: 'second draft' }],
    connections: [{ id: 'prompt-edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'first', port: 'prompt' }, type: 'text' }]
};
const graph = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>({nodes:record.value.nodes,connections:record.value.connections}))");
const composer = app => app.evaluate("document.getElementById('prompt-agent-input').value");
const models = app => app.evaluate("['prompt-agent-model','prompt-agent-image-model'].map(id=>document.getElementById(id).value)");

async function open(app, id = 'first') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}
async function nativeClick(app, selector) {
    const point = await app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`), true, `${selector} is reachable through the real parameter panel`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

test('the native in-panel optimize action stages the generation target and its editable Text source once without sending or changing the graph', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("window.preparationRequests=[];const preparationFetch=window.fetch;window.fetch=(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(body.messages||typeof body.prompt==='string')preparationRequests.push(body)}return preparationFetch(url,options)}");
        const before = await graph(app), selectedModels = await models(app);
        await open(app);
        await nativeClick(app, '#first-assistant');
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        const prepared = await composer(app);
        assert.match(prepared, /@产品画面\[first\]/);
        assert.match(prepared, /@真实产品提示词\[source\]/);
        assert.match(prepared, /修改对象.*文本来源/);
        assert.match(await app.evaluate("document.getElementById('prompt-agent-node-context').textContent"), /真实产品提示词.*文本来源/);
        await nativeClick(app, '#first-assistant');
        assert.equal(await composer(app), prepared, 'preparing the same point again keeps one explicit target and source mention');
        await open(app, 'second');
        assert.equal(await composer(app), prepared, 'changing the canvas selection preserves the explicit target in the draft');
        assert.deepEqual(await models(app), selectedModels);
        assert.equal(await app.evaluate('preparationRequests.length'), 0);
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-message-user').length"), 0);
        assert.deepEqual(await graph(app), before);
    });
});

test('optimization preserves an existing native draft and original attachment until the user explicitly inserts the target and source', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async()=>{document.getElementById('btn-prompt-agent').click();const input=document.getElementById('prompt-agent-input');input.value='保留手写要求与附件';input.dispatchEvent(new Event('input',{bubbles:true}));const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(reference)})).blob()],'original-reference.png',{type:'image/png'}));document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
        await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===1&&!document.querySelector('#prompt-agent-references .is-loading')");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.some(node=>node.type==='ImageImport'&&node.imageImportAssetKey))");
        await app.evaluate("window.originalPreparationImage=document.querySelector('#prompt-agent-references img')");
        const selectedModels = await models(app), before = await graph(app);
        await open(app);
        await nativeClick(app, '#first-assistant');
        assert.equal(await composer(app), '保留手写要求与附件');
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-references img')===originalPreparationImage"), true);
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-references img').src"), reference);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-insert-node-context').disabled"), false);
        await nativeClick(app, '#prompt-agent-insert-node-context');
        const inserted = await composer(app);
        assert.match(inserted, /^保留手写要求与附件\n@产品画面\[first\]/);
        assert.match(inserted, /@真实产品提示词\[source\]/);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-insert-node-context').disabled"), true);
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-references img')===originalPreparationImage"), true);
        assert.deepEqual(await models(app), selectedModels);
        assert.deepEqual(await graph(app), before);
    });
});

test('a Camera derived prompt names its original editor and prepares advice without authorizing a source or local-draft mutation', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { id: 'source', type: 'CameraControl', x: -600, y: 40, customTitle: '产品拍摄视角', pitch: 15, yaw: 20, distance: 5, fov: 60, roll: 0 },
        ...session.nodes.slice(1)
    ] }, async app => {
        const before = await graph(app);
        await open(app);
        await nativeClick(app, '#first-assistant');
        const prepared = await composer(app), hint = await app.evaluate("document.getElementById('prompt-agent-node-context').textContent");
        assert.match(prepared, /@产品画面\[first\]/);
        assert.doesNotMatch(prepared, /@产品拍摄视角\[source\]/);
        assert.match(prepared, /助手仅提供建议/);
        assert.match(hint, /产品拍摄视角.*只读.*内容由视角参数派生.*视角编辑器/);
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), '无效的本地草稿');
        assert.deepEqual(await graph(app), before);
    });
});
