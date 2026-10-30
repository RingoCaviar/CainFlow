import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['provider'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['provider'] }
    ],
    providers: [{ id: 'provider', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'editor-first', type: 'ImageGenerate', x: 80, y: 40, width: 420,
            apiConfigId: 'image', providerId: 'provider', prompt: 'first local draft' },
        { id: 'editor-second', type: 'ImageGenerate', x: 590, y: 40, width: 420,
            apiConfigId: 'image', providerId: 'provider', prompt: 'second local draft' }
    ],
    connections: []
};

async function openNode(app, id) {
    await app.evaluate(`document.querySelector('#${id} .image-first-placeholder').click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.hidden===false && document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
}

async function changeField(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function geometry(app) {
    return app.evaluate(`['editor-first','editor-second'].map(id=>{const element=document.getElementById(id);return {id,left:element.style.left,top:element.style.top,width:element.offsetWidth}})`);
}

async function editorMeasurements(app, id) {
    return app.evaluate(`(()=>{const panel=document.getElementById('image-parameter-panel');return {panels:document.querySelectorAll('.image-parameter-panel:not([hidden])').length,width:panel.getBoundingClientRect().width,font:getComputedStyle(document.getElementById('${id}-prompt')).fontSize,ownsPrompt:panel.contains(document.getElementById('${id}-prompt'))}})()`);
}

test('one screen-space image editor follows selection and preserves edits, width and layout across closing, zoom and reload', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const originalLayout = await geometry(app);
        assert.deepEqual(originalLayout, [
            { id: 'editor-first', left: '80px', top: '40px', width: 420 },
            { id: 'editor-second', left: '590px', top: '40px', width: 420 }
        ]);

        assert.equal(await app.evaluate("document.querySelector('#editor-first .image-first-placeholder button')"), null);
        await openNode(app, 'editor-first');
        assert.equal((await editorMeasurements(app, 'editor-first')).panels, 1);
        await changeField(app, 'editor-first-prompt', 'preserved first image prompt');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=size]').click()");
        await changeField(app, 'editor-first-resolution', 'custom');
        await changeField(app, 'editor-first-custom-resolution-width', '1536');
        await changeField(app, 'editor-first-custom-resolution-height', '1024');

        // Use the editor's keyboard resize control, rather than modifying its
        // dimensions or reading its preference implementation directly.
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        for (let step = 0; step < 3; step += 1) {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
        }
        const beforeZoom = await editorMeasurements(app, 'editor-first');
        assert.equal(beforeZoom.width, 510);
        assert.ok(Number.parseFloat(beforeZoom.font) >= 13, 'editor text retains the readable application font size');

        await openNode(app, 'editor-second');
        assert.deepEqual(await editorMeasurements(app, 'editor-second'), { ...beforeZoom, ownsPrompt: true });
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('editor-first-prompt'))"), false);
        await changeField(app, 'editor-second-prompt', 'preserved second image prompt');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);

        await openNode(app, 'editor-first');
        assert.equal(await app.evaluate("document.getElementById('editor-first-prompt').value"), 'preserved first image prompt');
        assert.deepEqual(await app.evaluate("['resolution','custom-resolution-width','custom-resolution-height'].map(suffix=>document.getElementById('editor-first-'+suffix).value)"), ['custom', '1536', '1024']);
        assert.deepEqual(await editorMeasurements(app, 'editor-first'), beforeZoom);

        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await editorMeasurements(app, 'editor-first'), beforeZoom, 'zoom changes the canvas, not the editor width, text size or ownership');
        assert.deepEqual(await geometry(app), originalLayout, 'selection, closing and canvas zoom do not rewrite graph coordinates or node widths');

        // The real application session document is the persisted graph boundary.
        // No private in-memory node state is read to prove that edits survived.
        await app.waitFor(`(async()=>{const response=await fetch('/api/storage/documents/session').then(r=>r.json());const nodes=response.value?.nodes||[];return nodes.find(n=>n.id==='editor-first')?.prompt==='preserved first image prompt' && nodes.find(n=>n.id==='editor-second')?.prompt==='preserved second image prompt'})()`);
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>({nodes:r.value.nodes.map(n=>({id:n.id,x:n.x,y:n.y,width:n.width,prompt:n.prompt,resolution:n.resolution,customWidth:n.customWidth,customHeight:n.customHeight})),connections:r.value.connections}))");
        assert.deepEqual(saved.connections, []);
        assert.deepEqual(saved.nodes.find(node => node.id === 'editor-first'), {
            id: 'editor-first', x: 80, y: 40, width: 420, prompt: 'preserved first image prompt',
            resolution: 'custom', customWidth: '1536', customHeight: '1024'
        });
        assert.equal(saved.nodes.find(node => node.id === 'editor-second').prompt, 'preserved second image prompt');

        await reloadAppBrowser(app);
        await openNode(app, 'editor-second');
        assert.equal(await app.evaluate("document.getElementById('editor-second-prompt').value"), 'preserved second image prompt');
        assert.deepEqual(await editorMeasurements(app, 'editor-second'), beforeZoom);
        await openNode(app, 'editor-first');
        assert.deepEqual(await app.evaluate("['prompt','resolution','custom-resolution-width','custom-resolution-height'].map(suffix=>document.getElementById('editor-first-'+suffix).value)"), ['preserved first image prompt', 'custom', '1536', '1024']);
        assert.deepEqual(await geometry(app), originalLayout);
    });
});

test('cached workflows with the same node ID keep distinct editors when switching and deleting the other workflow node', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: [], connections: [] }, async app => {
        const documents = ['A', 'B'].map(name => ({
            name,
            graph: {
                workflowId: `image-editor-workflow-${name.toLowerCase()}`,
                nodes: [{ id: 'shared', type: 'ImageGenerate', x: 150, y: 40, width: 420,
                    apiConfigId: 'image', providerId: 'provider', prompt: `${name} original prompt` }],
                connections: []
            }
        }));
        for (const { name, graph } of documents) {
            assert.equal(await app.evaluate(`fetch('/api/workflows/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        }

        async function activate(name, prompt) {
            await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
            await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name="${name}"]'))`);
            await app.evaluate(`document.querySelector('.workflow-item[data-name="${name}"]').click()`);
            await app.waitFor(`document.querySelector('.workflow-item[data-name="${name}"]')?.classList.contains('is-active')===true`);
            await app.evaluate("document.getElementById('btn-close-workflow').click()");
            await app.waitFor(`document.getElementById('shared-prompt')?.value===${JSON.stringify(prompt)}`);
            assert.equal(await app.evaluate("document.querySelectorAll('[id=\"shared-prompt\"]').length"), 1,
                'only the active workflow form participates in document-level control lookup');
            await openNode(app, 'shared');
            assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('shared-prompt'))"), true);
            assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), prompt);
        }

        await activate('A', 'A original prompt');
        await changeField(app, 'shared-prompt', 'A edited prompt');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='shared')?.prompt==='A edited prompt')");
        await activate('B', 'B original prompt');
        await activate('A', 'A edited prompt');
        await activate('B', 'B original prompt');

        await app.evaluate("document.getElementById('shared').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-delete-nodes').click()");
        await app.waitFor("!document.getElementById('shared') && document.querySelectorAll('[id=\"shared-prompt\"]').length===0");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true,
            'deleting the active node closes its editor');

        await activate('A', 'A edited prompt');
        assert.equal(await app.evaluate("document.querySelectorAll('.image-parameter-panel:not([hidden])').length"), 1);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='shared')?.prompt==='A edited prompt')");
    });
});
