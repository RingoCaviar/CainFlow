import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const restored = [
    { id: 'legacy', type: 'ImageGenerate', x: 40, y: 100, height: 2309, width: 410,
        userResized: false, prompt: '雪景列车。'.repeat(45),
        textareaHeights: { prompt: 1593, 'param-systemPrompt': 60 }, imageResultPersistence: 'transient' },
    { id: 'manual', type: 'ImageGenerate', x: 500, y: 100, height: 1200, width: 410,
        userResized: true, prompt: '雪景列车。', textareaHeights: { prompt: 484 } },
    { id: 'collapsed', type: 'ImageGenerate', x: 960, y: 100, height: 64, width: 410,
        userResized: false, collapsed: true, collapsedExpandedHeight: 2309,
        prompt: '雪景列车。', textareaHeights: { prompt: 1593 } }
];
const configuration = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: restored.map(node => ({ ...node, apiConfigId: 'image', providerId: 'p' })), connections: [] };
const settle = app => app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const cards = app => app.evaluate("Object.fromEntries(['legacy','manual','collapsed'].map(id=>{const node=document.getElementById(id);return [id,{width:node.offsetWidth,height:node.offsetHeight,collapsed:node.classList.contains('collapsed')}]}))");

async function assertRealEditors(app) {
    const before = await cards(app), viewportHeight = await app.evaluate('innerHeight');
    assert.ok(before.legacy.height < viewportHeight, 'the automatic card stays compact instead of inheriting the 1593px editor or old 2309px card');
    assert.equal(before.manual.height, 1200, 'the explicitly resized card retains its actual DOM height');
    assert.ok(before.collapsed.height < viewportHeight); assert.equal(before.collapsed.collapsed, false);
    for (const node of restored) assert.equal(before[node.id].width, node.width);
    await app.evaluate("window.restoredHeightPrompts=Object.fromEntries(['legacy','manual','collapsed'].map(id=>[id,document.getElementById(id+'-prompt')]))");
    for (const node of restored) {
        await app.evaluate(`document.getElementById(${JSON.stringify(node.id)}).click()`);
        await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(node.id)}`);
        if (await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode!=='expanded'")) {
            await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
        }
        await settle(app);
        const editor = await app.evaluate(`(()=>{const id=${JSON.stringify(node.id)},prompt=document.getElementById(id+'-prompt'),panel=document.getElementById('image-parameter-panel'),scroll=panel.querySelector('.image-parameter-scroll');return {height:prompt.offsetHeight,value:prompt.value,original:prompt===restoredHeightPrompts[id],inPanel:panel.contains(prompt),inCard:document.getElementById(id).contains(prompt),count:document.querySelectorAll('#'+id+'-prompt').length,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight}})()`);
        assert.equal(editor.height, node.textareaHeights.prompt, node.id);
        assert.equal(editor.value, node.prompt); assert.equal(editor.original, true); assert.equal(editor.inPanel, true);
        assert.equal(editor.inCard, false); assert.equal(editor.count, 1);
        assert.ok(editor.scrollHeight >= editor.height, 'the original editor remains reachable in the panel scroll area');
        if (editor.height > viewportHeight) assert.ok(editor.scrollHeight > editor.clientHeight, 'the 1593px editor scrolls inside the bounded panel');
        assert.deepEqual(await cards(app), before, 'selecting and mounting editors never enlarges the image cards');
    }
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
    return before;
}

async function saveFile(app) {
    await waitForAutosave(app);
    await app.waitFor("fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json()).then(graph=>graph.nodes?.find(node=>node.id==='manual')?.height===1200&&graph.nodes.find(node=>node.id==='legacy')?.textareaHeights?.prompt===1593)");
    return app.evaluate("fetch('/api/workflows/'+encodeURIComponent(document.getElementById('toolbar-workflow-name').textContent.trim())).then(response=>response.json())");
}
function assertSavedHeights(graph) {
    assert.equal(graph.nodes.length, 3); assert.deepEqual(graph.connections, []);
    for (const original of restored) {
        const node = graph.nodes.find(node => node.id === original.id);
        assert.equal(node.textareaHeights.prompt, original.textareaHeights.prompt);
        assert.equal(node.prompt, original.prompt); assert.equal(node.userResized, original.userResized);
        assert.equal(node.height, original.userResized ? 1200 : null);
        assert.equal(Object.hasOwn(node, 'collapsedExpandedHeight'), false, 'automatic expanded height never persists the old long form');
    }
    assert.notEqual(graph.nodes.find(node => node.id === 'collapsed').collapsed, true);
}

test('restored image cards discard automatic card height while retaining saved editor heights', { timeout: 45000 }, async () => {
    await withAppBrowser(configuration, async app => {
        await assertRealEditors(app);
        assert.equal(await app.evaluate("document.querySelector('#collapsed .node-collapse-btn')===null"), true, 'legacy collapse state does not restore a retired control');
        const beforeReload = await cards(app), file = await saveFile(app);
        assertSavedHeights(file);
        await reloadAppBrowser(app);
        assert.deepEqual(await cards(app), beforeReload);
        await assertRealEditors(app);
        assertSavedHeights(await saveFile(app));
    });
});
