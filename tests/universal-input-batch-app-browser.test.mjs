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

const multiSourceSession = {
    ...configuration,
    nodes: [
        { id: 'first-image', type: 'ImageImport', x: 110, y: 140 },
        { id: 'second-image', type: 'ImageImport', x: 430, y: 140 },
        { id: 'no-output', type: 'CameraControl', x: 110, y: 450 },
        { id: 'video', type: 'VideoGenerate', x: 430, y: 450 },
        { id: 'target', type: 'ImageGenerate', x: 870, y: 270, apiConfigId: 'image', providerId: 'p' }
    ],
    connections: []
};

async function pointer(app, type, point, button = 'left') {
    await app.send('Input.dispatchMouseEvent', {
        type, ...point, button: type === 'mouseMoved' ? 'none' : button,
        buttons: type === 'mouseReleased' ? 0 : button === 'left' ? 1 : 2, clickCount: 1
    });
}

async function selectSources(app) {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // All built-in node types currently have outputs. Simulate a node that exposes none.
    await app.evaluate("document.querySelector('#no-output .node-outputs-section').remove()");
    const { from, to } = await app.evaluate(`(() => {
        const a = document.getElementById('first-image').getBoundingClientRect();
        const b = document.getElementById('video').getBoundingClientRect();
        return { from: { x: a.left - 20, y: a.top - 25 }, to: { x: b.left + 60, y: b.top + 55 } };
    })()`);
    await pointer(app, 'mousePressed', from);
    await pointer(app, 'mouseMoved', to);
    await pointer(app, 'mouseReleased', to);
    await assertSourcesSelected(app);
}

async function assertSourcesSelected(app) {
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node.selected')].map(node => node.id).sort()"),
        ['first-image', 'no-output', 'second-image', 'video']);
}

async function portPoint(app, selector) {
    return app.evaluate(`(() => {
        const dot = document.querySelector(${JSON.stringify(selector)});
        const rect = dot.getBoundingClientRect();
        const ratio = dot.closest('.node-port').dataset.direction === 'input' ? 0.25 : 0.75;
        return { x: rect.left + rect.width * ratio, y: rect.top + rect.height / 2 };
    })()`);
}

async function elementCenter(app, selector) {
    return app.evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
}

async function clickAt(app, point, button = 'left') {
    await pointer(app, 'mousePressed', point, button);
    await pointer(app, 'mouseReleased', point, button);
}

async function dragImagesToTarget(app, expectedCount) {
    const start = await portPoint(app, '#second-image .node-port[data-direction="output"] .port-dot');
    const target = await portPoint(app, '#target .universal-input .port-dot');
    // Exercise snapping through a release just outside the actual port dot.
    const drop = { x: target.x - 16, y: target.y };
    await pointer(app, 'mousePressed', start);
    await pointer(app, 'mouseMoved', { x: start.x + 30, y: start.y + 20 });
    await pointer(app, 'mouseMoved', drop);
    await app.waitFor(`document.querySelector('.connection-batch-preview')?.textContent.trim() === '连接 ${expectedCount} 个来源'`);
    await pointer(app, 'mouseReleased', drop);
}

async function assertImageReferences(app, sourceIds) {
    await app.waitFor(`fetch('/api/storage/documents/session').then(response => response.json()).then(document => document.value?.connections?.length === ${sourceIds.length})`);
    const saved = (await graph(app)).connections;
    assert.deepEqual(saved.map(({ from, to, order }) => ({ from, to, order })), sourceIds.map((nodeId, order) => ({
        from: { nodeId, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, order
    })));
    await app.waitFor(`document.querySelectorAll('#connections-svg path[data-conn-id]').length === ${sourceIds.length}`);
    return saved;
}

async function assertBatchUndone(app) {
    await shortcut(app, 'z');
    await app.waitFor("document.querySelectorAll('#connections-svg path[data-conn-id]').length === 0");
    await app.waitFor("fetch('/api/storage/documents/session').then(response => response.json()).then(document => document.value?.connections?.length === 0)");
}

async function watchForConnectionWarnings(app) {
    await app.evaluate("window.previousBatchWarnings = new WeakSet(document.querySelectorAll('.toast.warning, .toast.error'))");
    return async () => {
        const warnings = await app.evaluate(`Array.from(document.querySelectorAll('.toast.warning, .toast.error'))
            .filter(toast => !window.previousBatchWarnings.has(toast) && !toast.textContent.includes('代理/透明代理'))
            .map(toast => toast.textContent)`);
        assert.deepEqual(warnings, [], 'skipped sources do not trigger warnings');
    };
}

test('dragging one selected image output connects all compatible selected sources in a single edit', { timeout: 30000 }, async () => {
    await withAppBrowser(multiSourceSession, async app => {
        await selectSources(app);
        const assertNoWarnings = await watchForConnectionWarnings(app);
        await dragImagesToTarget(app, 2);
        await assertNoWarnings();

        const sourceIds = ['second-image', 'first-image'];
        const saved = await assertImageReferences(app, sourceIds);
        await assertSourcesSelected(app);
        assert.equal(await app.evaluate("document.querySelector('.connection-batch-preview')?.getClientRects().length > 0"), false);
        await assertBatchUndone(app);
        await shortcut(app, 'y');
        assert.deepEqual(await assertImageReferences(app, sourceIds), saved);
    });
});

test('dragging from an already connected anchor adds only the new selected source', { timeout: 30000 }, async () => {
    const retained = {
        id: 'retained', from: { nodeId: 'second-image', port: 'image' },
        to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 0
    };
    await withAppBrowser({ ...multiSourceSession, connections: [retained] }, async app => {
        await selectSources(app);
        await dragImagesToTarget(app, 1);
        const [first] = await assertImageReferences(app, ['second-image', 'first-image']);
        assert.deepEqual(first, retained);
        await shortcut(app, 'z');
        assert.deepEqual(await assertImageReferences(app, ['second-image']), [retained]);
    });
});

test('the multi-selection context menu connects eligible sources when the user clicks a target', { timeout: 30000 }, async () => {
    await withAppBrowser(multiSourceSession, async app => {
        await selectSources(app);
        const assertNoWarnings = await watchForConnectionWarnings(app);
        await clickAt(app, await elementCenter(app, '#no-output .node-header'), 'right');
        const menuItem = '#context-menu-batch-connection-mode';
        assert.equal(await app.evaluate(`document.querySelector('${menuItem}').getClientRects().length > 0`), true,
            'right-clicking a selected node without an output exposes the action for the whole selection');
        assert.equal(await app.evaluate("document.getElementById('context-menu-batch-connection-summary').textContent"), '可用 3 / 4');
        await assertSourcesSelected(app);
        await clickAt(app, await elementCenter(app, menuItem));
        await app.waitFor("document.getElementById('canvas-container').classList.contains('batch-connection-mode-active')");
        await clickAt(app, await elementCenter(app, '#target .image-first-placeholder'));
        await assertNoWarnings();
        await assertImageReferences(app, ['first-image', 'second-image']);
        await leaveBatch(app);
        await assertBatchUndone(app);
    });
});

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
