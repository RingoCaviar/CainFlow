import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};

async function enterBatch(app, source) {
    await app.evaluate(`document.getElementById('${source}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:180}));document.getElementById('context-menu-batch-connection-mode').click()`);
    await app.waitFor("document.getElementById('canvas-container').classList.contains('batch-connection-mode-active')");
}
async function clickTarget(app) {
    await app.evaluate("document.getElementById('target').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:640,clientY:240}))");
}
async function graph(app) {
    return app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
}
async function leaveBatch(app) {
    const parametersOpen = await app.evaluate("document.getElementById('image-parameter-panel')?.hidden===false");
    await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    if (parametersOpen) {
        await app.waitFor("document.getElementById('image-parameter-panel').hidden");
        assert.equal(await app.evaluate("document.getElementById('canvas-container').classList.contains('batch-connection-mode-active')"), true,
            'Escape closes the visible parameter editor before leaving the underlying batch mode');
        await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    }
    await app.waitFor("!document.getElementById('canvas-container').classList.contains('batch-connection-mode-active')");
}
async function shortcut(app, key) {
    await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',ctrlKey:true,bubbles:true,cancelable:true}))`);
}

test('batch connection UI uses a canonical camera role with one graph undo and redo', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'camera', type: 'CameraControl', x: 40, y: 80 },
        { id: 'target', type: 'ImageGenerate', x: 600, y: 80, apiConfigId: 'image', providerId: 'p' }
    ], connections: [] }, async app => {
        await enterBatch(app, 'camera'); await clickTarget(app);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections?.length===1)");
        const saved = (await graph(app)).connections;
        assert.deepEqual(saved[0].from, { nodeId: 'camera', port: 'text' });
        assert.deepEqual(saved[0].to, { nodeId: 'target', port: 'camera_prompt' });
        assert.equal(saved[0].type, 'text');
        await leaveBatch(app);
        await shortcut(app, 'z');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections?.length===0)");
        await shortcut(app, 'z');
        await delay(80);
        await shortcut(app, 'y');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.connections?.length===1)");
        assert.deepEqual((await graph(app)).connections, saved, 'one redo restores the entire edit after exhausting its single undo entry');
    });
});

test('batch connection UI refuses a full prompt without changing its edge or consuming history', { timeout: 30000 }, async () => {
    const edge = { id: 'old-prompt', from: { nodeId: 'old', port: 'text' }, to: { nodeId: 'target', port: 'prompt' }, type: 'text' };
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'old', type: 'Text', x: 40, y: 80, text: 'old prompt' },
        { id: 'next', type: 'Text', x: 40, y: 400, text: 'new prompt' },
        { id: 'target', type: 'ImageGenerate', x: 600, y: 80, apiConfigId: 'image', providerId: 'p' }
    ], connections: [edge] }, async app => {
        await enterBatch(app, 'next'); await clickTarget(app);
        await app.waitFor("Array.from(document.querySelectorAll('.toast')).some(element=>element.textContent.includes('已占用'))");
        assert.deepEqual((await graph(app)).connections, [edge]);
        await leaveBatch(app);
        await shortcut(app, 'z');
        await delay(150);
        assert.equal(await app.evaluate("Array.from(document.querySelectorAll('.toast')).some(element=>element.textContent.includes('已撤回'))"), false);
        assert.deepEqual((await graph(app)).connections, [edge]);
    });
});
