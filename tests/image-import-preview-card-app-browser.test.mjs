import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'import-card', type: 'ImageImport', x: 80, y: 40, width: 240 },
        { id: 'preview-card', type: 'ImagePreview', x: 440, y: 40, width: 240 }],
    connections: [{ id: 'preview-edge', from: { nodeId: 'import-card', port: 'image' }, to: { nodeId: 'preview-card', port: 'image' }, type: 'image' }]
};

async function open(app, id) {
    await app.evaluate(`document.getElementById('${id}').click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.dataset.nodeId==='${id}' && !document.getElementById('image-parameter-panel').hidden`);
}
async function upload(app) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(png)})).blob()],'local-reference.png',{type:'image/png'}));const input=document.getElementById('import-card-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='import-card')?.mediaAssetKeys?.length===1)");
}

test('parameter windows center on their card until the viewport edge requires clamping', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const measure = id => app.evaluate(`(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),n=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {left:p.left,right:p.right,expected:Math.max(12,Math.min(innerWidth-12-p.width,n.left+(n.width-p.width)/2))}})()`);
        await open(app, 'import-card');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const normal = await measure('import-card');
        assert.ok(Math.abs(normal.left-normal.expected)<=1, 'upload editor uses its rendered minimum width when centering');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 480, deviceScaleFactor: 1, mobile: false });
        await open(app, 'preview-card');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const edge = await measure('preview-card');
        assert.ok(Math.abs(edge.left-edge.expected)<=1 && edge.left>=12 && edge.right<=348,
            'a card beyond the right edge keeps the editor inside the viewport');
    });
});

test('image import keeps its original upload and URL previews on a compact card while original fields follow the shared editor', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app, 'import-card');
        assert.equal(await app.evaluate("document.getElementById('import-card').classList.contains('image-first-card')"), true);
        assert.equal(await app.evaluate("document.querySelectorAll('#import-card .node-port[data-direction=input]').length"), 0);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('import-card-url-input'))"), true);
        assert.equal(await app.evaluate("document.getElementById('import-card').contains(document.getElementById('import-card-file')) && document.getElementById('image-parameter-panel').contains(document.getElementById('import-card-select-btn'))"), true);
        assert.equal(await app.evaluate("document.getElementById('import-card').contains(document.getElementById('import-card-res'))"), false,
            'dimensions and the upload action stay in the editor, leaving only the thumbnail on the card');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').hidden"), true, 'import does not present a generation action');

        await app.evaluate("document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=url]').click()");
        await app.waitFor("!document.getElementById('import-card-url-section').classList.contains('hidden') && !document.querySelector('#image-parameter-panel .image-import-url-fields').hidden");
        const url = `${app.server.baseUrl}/tests/fixtures/reference-red.png`;
        await app.evaluate(`(()=>{const field=document.getElementById('import-card-url-input');field.value=${JSON.stringify(url)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='import-card')?.imageUrl===${JSON.stringify(url)})`);
        await open(app, 'preview-card');
        await open(app, 'import-card');
        assert.equal(await app.evaluate("document.getElementById('import-card-url-input').value"), url);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('[id=import-card-url-input]').length"), 1);
        await open(app, 'import-card');
        await app.evaluate("document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=upload]').click()");
        await app.waitFor("!document.getElementById('import-card-upload-section').classList.contains('hidden') && document.querySelector('#image-parameter-panel .image-import-url-fields').hidden");
        await upload(app);
        await app.waitFor("!!document.querySelector('#import-card-drop img')");
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#import-card-drop img')).objectFit"), 'contain');
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>({nodes:document.value.nodes.map(node=>({id:node.id,x:node.x,y:node.y,width:node.width})),connections:document.value.connections}))");
        assert.deepEqual(saved.nodes, session.nodes.map(({ id, x, y, width }) => ({ id, x, y, width })));
        assert.deepEqual(saved.connections, session.connections);
        await reloadAppBrowser(app);
        await open(app, 'import-card');
        await app.waitFor("!!document.querySelector('#import-card-drop img')");
        assert.equal(await app.evaluate("document.getElementById('import-card-import-mode').value"), 'upload');
    });
});

test('preview keeps its original local controls on the card and updates from its single universal input through the shared editor', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await upload(app);
        await open(app, 'preview-card');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#preview-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>({port:port.dataset.port,type:port.dataset.type}))"), [{ port: 'auto', type: 'any' }]);
        assert.equal(await app.evaluate("document.getElementById('preview-card').contains(document.getElementById('preview-card-controls'))"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '更新预览');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').click()");
        await app.waitFor("!!document.querySelector('#preview-card-preview img') && getComputedStyle(document.getElementById('preview-card-controls')).display!=='none'");
        const height = await app.evaluate("document.getElementById('preview-card').offsetHeight");
        await app.evaluate("document.getElementById('preview-card-zoom-in').click()");
        assert.match(await app.evaluate("document.querySelector('#preview-card-preview img').style.transform"), /scale\(1\.25\)/);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.nodeId"), 'preview-card');
        await app.evaluate("document.getElementById('preview-card-zoom-reset').click()");
        assert.equal(await app.evaluate("document.querySelector('#preview-card-preview img').style.transform"), 'scale(1)');
        assert.equal(await app.evaluate("document.getElementById('preview-card').offsetHeight"), height);
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#preview-card-preview img')).objectFit"), 'contain');
        const ports = await app.evaluate("(()=>{const card=document.getElementById('preview-card').getBoundingClientRect(),surface=document.getElementById('preview-card-preview').getBoundingClientRect();return [...document.querySelectorAll('#preview-card .node-port')].filter(port=>port.getClientRects().length).map(port=>{const dot=port.querySelector('.port-dot').getBoundingClientRect(),label=port.querySelector('.port-label').getBoundingClientRect();return {direction:port.dataset.direction,dot:dot.x+dot.width/2,edge:port.dataset.direction==='input'?card.left:card.right,labelHidden:getComputedStyle(port.querySelector('.port-label')).display==='none'}})})()");
        for (const { direction, dot, edge, labelHidden } of ports) {
            const outwardGap = direction === 'input' ? edge - dot : dot - edge;
            assert.ok(outwardGap > 2 && outwardGap < 5, `${direction} port sits outside the card: ${outwardGap}px`);
            assert.equal(labelHidden, true);
        }
        await app.evaluate("document.getElementById('preview-card-fullscreen').click()");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await app.evaluate("document.querySelector('#preview-card-preview img').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true,cancelable:true}))");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false, 'single click selects the image editor without stealing local preview actions');
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections)"), session.connections);
    });
});

test('cached import workflows sharing a node ID retain their own mode and URL editor after switching and deleting the other node', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: [], connections: [] }, async app => {
        const url = `${app.server.baseUrl}/tests/fixtures/reference-red.png`;
        const edited = `${app.server.baseUrl}/tests/fixtures/reference-blue.png`;
        for (const name of ['A', 'B']) {
            const graph = { workflowId: `import-editor-${name}`, nodes: [{ id: 'shared-import', type: 'ImageImport', x: 100, y: 40,
                importMode: name === 'A' ? 'url' : 'upload', imageUrl: name === 'A' ? url : '' }], connections: [] };
            assert.equal(await app.evaluate(`fetch('/api/workflows/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        }
        async function activate(name, expectedMode, expectedUrl) {
            await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
            await app.waitFor(`!!document.querySelector('.workflow-item[data-name="${name}"]')`);
            await app.evaluate(`document.querySelector('.workflow-item[data-name="${name}"]').click()`);
            await app.waitFor(`document.querySelector('.workflow-item[data-name="${name}"]')?.classList.contains('is-active')`);
            await app.evaluate("document.getElementById('btn-close-workflow').click()");
            await open(app, 'shared-import');
            assert.equal(await app.evaluate("document.querySelectorAll('[id=shared-import-url-input]').length"), 1);
            assert.deepEqual(await app.evaluate("[document.getElementById('shared-import-import-mode').value,document.getElementById('shared-import-url-input').value]"), [expectedMode, expectedUrl]);
            assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-import-url-fields').hidden"), expectedMode !== 'url');
        }
        await activate('A', 'url', url);
        await app.evaluate(`(()=>{const input=document.getElementById('shared-import-url-input');input.value=${JSON.stringify(edited)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='shared-import')?.imageUrl===${JSON.stringify(edited)})`);
        await activate('B', 'upload', '');
        await activate('A', 'url', edited);
        await activate('B', 'upload', '');
        await app.evaluate("document.getElementById('shared-import').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-delete-nodes').click()");
        await app.waitFor("!document.getElementById('shared-import') && document.querySelectorAll('[id=shared-import-url-input]').length===0");
        await activate('A', 'url', edited);
    });
});
