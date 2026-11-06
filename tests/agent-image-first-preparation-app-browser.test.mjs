import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser } from './helpers/app-browser.mjs';

const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'Text', x: -600, y: 40, customTitle: '真实产品提示词', text: '上游的有效产品描述' },
        { id: 'first', type: 'ImageGenerate', x: 80, y: 40, width: 420, height: 220, userResized: true, customTitle: '产品画面', apiConfigId: 'image', providerId: 'p', prompt: '无效的本地草稿' },
        { id: 'second', type: 'ImageGenerate', x: 600, y: 40, width: 420, height: 220, userResized: true, customTitle: '另一个画面', apiConfigId: 'image', providerId: 'p', prompt: 'second draft' }],
    connections: [{ id: 'prompt-edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'first', port: 'prompt' }, type: 'text' }]
};

async function open(app, id = 'first') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}&&!document.getElementById('image-parameter-panel').hidden`);
}

test('image parameters have no removed optimization action and editing does not open Agent or send requests', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("window.preparationRequests=0;const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url)==='/proxy')preparationRequests++;return originalFetch(url,options)}");
        await open(app);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-prompt-actions,#first-assistant')"), null);
        await open(app, 'second');
        await app.evaluate("const p=document.getElementById('second-prompt');p.value='edited draft';p.dispatchEvent(new Event('input',{bubbles:true}))");
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-panel').classList.contains('active')"), false);
        assert.equal(await app.evaluate('preparationRequests'), 0);
    });
});

test('opening parameters preserves an independently composed Agent draft and original attachment', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async()=>{document.getElementById('btn-prompt-agent').click();const input=document.getElementById('prompt-agent-input');input.value='保留手写要求与附件';input.dispatchEvent(new Event('input',{bubbles:true}));const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(reference)})).blob()],'reference.png',{type:'image/png'}));document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
        await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===1&&!document.querySelector('#prompt-agent-references .is-loading')");
        for (const id of ['first','second','first']) await open(app, id);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), '保留手写要求与附件');
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-references img').src"), reference);
        assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel .image-node-assistant').length"), 0);
    });
});
