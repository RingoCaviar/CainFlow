import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'ImageImport', x: 60, y: 320 }],
    connections: []
};

async function point(app, selector) {
    // Only the outside half of each port dot is visible and accepts pointer input.
    return app.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),direction=el.closest('.node-port')?.dataset.direction;return {x:r.x+r.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:r.y+r.height/2}})()`);
}

async function click(app, selector) {
    const p = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
}

async function dragFromPort(app, selector, destination, expectPopup = true) {
    const from = await point(app, selector);
    assert.ok(await app.evaluate(`!!document.elementFromPoint(${from.x},${from.y})?.closest('.node-port')`), `port is reachable at ${JSON.stringify(from)}: ${await app.evaluate(`document.elementFromPoint(${from.x},${from.y})?.outerHTML.slice(0,700)`)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 30, y: from.y + 20, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destination, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 });
    if (expectPopup) await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
}

async function assertConnected(app, fromId, toId, toPort, { fromPort = '', connectionId = '' } = {}) {
    const expression = `(()=>{
        const path=document.querySelector('#connections-svg path[data-conn-id${connectionId ? `="${connectionId}"` : ''}]');
        const from=document.querySelector('#${fromId} .node-port[data-direction="output"]${fromPort ? `[data-port="${fromPort}"]` : ''} .port-dot');
        const to=document.querySelector('#${toId} .node-port[data-direction="input"][data-port="${toPort}"] .port-dot');
        if(!path?.getAttribute('d') || !from || !to) return false;
        const matrix=path.getScreenCTM(),start=path.getPointAtLength(0).matrixTransform(matrix),end=path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
        const a=from.getBoundingClientRect(),b=to.getBoundingClientRect();
        return Math.hypot(start.x-a.x-a.width/2,start.y-a.y-a.height/2)<2 && Math.hypot(end.x-b.x-b.width/2,end.y-b.y-b.height/2)<2;
    })()`;
    await app.waitFor(expression);
    assert.equal(await app.evaluate(expression), true, 'a visible path must reach both connected port dots without moving or zooming');
}

async function savedConnections(app, count = 1, newNodeId = '') {
    await app.waitFor(`(async()=>{const saved=await fetch('/api/storage/documents/session').then(r=>r.json());return saved.value?.connections?.length===${count} && (!${JSON.stringify(newNodeId)} || saved.value.connections.some(link=>[link.from.nodeId,link.to.nodeId].includes(${JSON.stringify(newNodeId)})))})().catch(()=>false)`);
    return app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(saved=>saved.value.connections.map(({from,to})=>({from,to})))");
}

test('dragging an image output onto blank canvas creates a node with an immediately visible reference connection', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageGenerate"]');
        await app.waitFor("document.querySelectorAll('.node-generate').length===1");
        await app.waitFor("document.querySelectorAll('.image-reference-group').length===1");
        const target = await app.evaluate("document.querySelector('.node-generate').id");
        await assertConnected(app, 'source', target, 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: target, port: 'referenceImages' } }]);

        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#connections-svg path[data-conn-id]').length===0 && document.querySelectorAll('.image-reference-group').length===0 && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('.image-reference-group').length===1");
        await assertConnected(app, 'source', target, 'referenceImages');
        await savedConnections(app);

        const previous = await app.evaluate('performance.timeOrigin');
        await app.send('Page.reload', { ignoreCache: true });
        await app.waitFor(`performance.timeOrigin!==${previous} && window.__cainflowAppReady===true && document.querySelectorAll('.image-reference-group').length===1`);
        await app.waitFor("Boolean(document.querySelector('#connections-svg path[data-conn-id]')?.getAttribute('d'))");
        await assertConnected(app, 'source', target, 'referenceImages');
    });
});

const allTypes = ['ImageImport', 'ImageCompare', 'ImageMerge', 'ImageResize', 'ColorReset', 'ImageGenerate', 'VideoGenerate', 'CameraControl', 'CustomParams', 'TextChat', 'Text', 'TextMerge', 'TextSplit', 'ImagePreview', 'ImageSave'];
const inputCandidates = {
    image: ['ImageCompare', 'ImageMerge', 'ImageResize', 'ColorReset', 'ImageGenerate', 'VideoGenerate', 'CameraControl', 'TextChat', 'ImagePreview', 'ImageSave'],
    text: ['ImageGenerate', 'VideoGenerate', 'TextChat', 'Text', 'TextMerge', 'TextSplit'],
    params: ['ImageGenerate', 'VideoGenerate', 'TextChat'], video: ['ImageSave']
};
const outputCandidates = {
    image: ['ImageImport', 'ImageCompare', 'ImageMerge', 'ImageResize', 'ColorReset', 'ImageGenerate', 'ImagePreview', 'ImageSave'],
    text: ['CameraControl', 'TextChat', 'Text', 'TextMerge', 'TextSplit'],
    params: ['CustomParams'], video: ['VideoGenerate', 'ImageSave'], any: allTypes
};
const retained = [
    { id: 'retained-b', from: { nodeId: 'old-b', port: 'image' }, to: { nodeId: 'old-target', port: 'referenceImages' }, type: 'image', order: 0 },
    { id: 'retained-a', from: { nodeId: 'old-a', port: 'image' }, to: { nodeId: 'old-target', port: 'referenceImages' }, type: 'image', order: 1 }
];
const matrixSession = {
    ...session,
    models: [...session.models, { id: 'video', modelId: 'veo-3', name: '受控视频', protocol: 'veo-unified', taskType: 'video', providerIds: ['p'] }],
    nodeDefaults: { VideoGenerate: { apiConfigId: 'video', providerId: 'p' } },
    connections: retained
};
const protectedNodes = [
    { id: 'old-a', type: 'ImageImport', x: 1800, y: 200 },
    { id: 'old-b', type: 'ImageImport', x: 1800, y: 600 },
    { id: 'old-target', type: 'ImageGenerate', x: 2300, y: 200 }
];
const dynamicData = {
    TextSplit: { outputCount: 3, text: 'one\n\ntwo\n\nthree' },
    TextMerge: { inputCount: 3 }, ImageMerge: { inputCount: 3 },
    CustomParams: { params: [{ key: 'payload', value: '' }, { key: 'other', value: '' }] }
};

describe('port creation compatibility matrix', { concurrency: 2 }, () => {
for (const type of allTypes) for (const direction of ['input', 'output']) {
    if (type === 'ImageImport' && direction === 'input') continue;
    test(`all ${type} ${direction} creation candidates connect visible ports and preserve existing references`, { timeout: 180000 }, async t => {
        await withAppBrowser({ ...matrixSession, nodes: [...protectedNodes, { id: 'source', type, x: direction === 'output' ? 60 : 620, y: 260, ...dynamicData[type] }] }, async app => {
            const ports = await app.evaluate(`[...document.querySelectorAll('#source .node-port[data-direction="${direction}"]')].filter(p=>!p.classList.contains('hidden')&&p.offsetHeight>0).map(p=>({name:p.dataset.port,type:p.dataset.type}))`);
            assert.ok(ports.length > 0, `${type} exposes ${direction} ports`);
            let checked = 0;
            for (const port of ports) {
                const selector = `#source .node-port[data-direction="${direction}"][data-port="${port.name}"] .port-dot`;
                const expected = (direction === 'output' ? inputCandidates : outputCandidates)[port.type];
                assert.ok(expected?.length, `known compatibility contract for ${type}.${port.name}`);
                for (const [index, candidate] of expected.entries()) {
                    t.diagnostic(`${type}.${port.name} ${direction}: create ${candidate}`);
                    await dragFromPort(app, selector, { x: direction === 'output' ? 620 : 200, y: 240 });
                    if (index === 0) assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#connection-create-popup [data-popup-node-type]')].map(p=>p.dataset.popupNodeType).sort()"), [...expected].sort(), `${type}.${port.name} menu matches compatible node types`);
                    await click(app, `#connection-create-popup [data-popup-node-type="${candidate}"]`);
                    await app.waitFor("document.querySelectorAll('#nodes-layer > .node').length===5");
                    const id = await app.evaluate("[...document.querySelectorAll('#nodes-layer > .node')].find(n=>!['source','old-a','old-b','old-target'].includes(n.id)).id");
                    await savedConnections(app, 3, id);
                    const links = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)");
                    assert.deepEqual(links.filter(link => link.id.startsWith('retained-')), retained, `${type}.${port.name} -> ${candidate} leaves existing references and order intact`);
                    const link = links.find(link => !link.id.startsWith('retained-'));
                    assert.deepEqual(direction === 'output' ? link.from : link.to, { nodeId: 'source', port: port.name }, 'the connection retains the exact dragged port');
                    assert.equal(direction === 'output' ? link.to.nodeId : link.from.nodeId, id, 'the other endpoint is the newly created node');
                    const types = await app.evaluate(`(()=>{const from=document.querySelector('#${link.from.nodeId} .node-port[data-direction="output"][data-port="${link.from.port}"]'),to=document.querySelector('#${link.to.nodeId} .node-port[data-direction="input"][data-port="${link.to.port}"]');return {from:from?.dataset.type,to:to?.dataset.type}})()`);
                    assert.ok(types.from && types.to && (types.to === 'any' || types.from === types.to), `${type}.${port.name} -> ${candidate} uses actual compatible ports`);
                    assert.equal(link.type, types.from, 'the stored type is the real source type');
                    await assertConnected(app, link.from.nodeId, link.to.nodeId, link.to.port, { fromPort: link.from.port, connectionId: link.id });
                    await app.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:220}));document.getElementById('context-menu-delete-nodes').click()`);
                    await app.waitFor("document.querySelectorAll('#nodes-layer > .node').length===4 && document.getElementById('context-menu').classList.contains('hidden')");
                    await savedConnections(app, 2);
                    checked++;
                }
            }
            t.diagnostic(`${ports.length} visible ports; ${checked} compatible creations; existing ordered reference edges preserved`);
        });
    });
}
});

test('dragging an image output to create a chat node connects its current multi-reference input', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
        await click(app, '#connection-create-popup [data-popup-node-type="TextChat"]');
        await app.waitFor("document.querySelectorAll('.node-chat').length===1");
        const target = await app.evaluate("document.querySelector('.node-chat').id");
        await assertConnected(app, 'source', target, 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: target, port: 'referenceImages' } }]);
    });
});

test('dragging a reference input to create an image source keeps the connection direction', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'target', type: 'ImageGenerate', x: 620, y: 320 }] }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="referenceImages"] .port-dot', { x: 200, y: 260 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageImport"]');
        await app.waitFor("document.querySelectorAll('.node-import').length===1");
        const source = await app.evaluate("document.querySelector('.node-import').id");
        await assertConnected(app, source, 'target', 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: source, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' } }]);
    });
});

for (const [type, port] of [['Text', 'prompt'], ['CameraControl', 'camera_prompt']]) {
    test(`dragging ${type} output to create an image node retains the preferred text input`, { timeout: 30000 }, async () => {
        await withAppBrowser({ ...session, nodes: [{ id: 'source', type, x: 60, y: 320 }] }, async app => {
            await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
            await click(app, '#connection-create-popup [data-popup-node-type="ImageGenerate"]');
            await app.waitFor("document.querySelectorAll('.node-generate').length===1");
            const target = await app.evaluate("document.querySelector('.node-generate').id");
            await assertConnected(app, 'source', target, port);
            assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'text' }, to: { nodeId: target, port } }]);
        });
    });
}

test('creating a text split node from a prompt input connects the actual initial output', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'target', type: 'ImageGenerate', x: 620, y: 320 }] }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="prompt"] .port-dot', { x: 200, y: 260 });
        await click(app, '#connection-create-popup [data-popup-node-type="TextSplit"]');
        await app.waitFor("document.querySelectorAll('.node-text-split').length===1");
        const source = await app.evaluate("document.querySelector('.node-text-split').id");
        await assertConnected(app, source, 'target', 'prompt');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: source, port: 'part_1' }, to: { nodeId: 'target', port: 'prompt' } }]);
    });
});

test('creating a protocol-driven video node from an image output uses its selected model reference input', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session,
        models: [...session.models, { id: 'video', modelId: 'kling-o3', name: '受控视频', protocol: 'async-video-api', taskType: 'video', providerIds: ['p'] }],
        nodeDefaults: { VideoGenerate: { apiConfigId: 'video', providerId: 'p' } }
    }, async app => {
        await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
        await click(app, '#connection-create-popup [data-popup-node-type="VideoGenerate"]');
        await app.waitFor("document.querySelectorAll('.node-video-generate').length===1");
        const target = await app.evaluate("document.querySelector('.node-video-generate').id");
        await assertConnected(app, 'source', target, 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: target, port: 'referenceImages' } }]);
    });
});

test('an any-type custom parameter input can create a typed source and retain the actual connection type', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'target', type: 'CustomParams', x: 620, y: 320, params: [{ key: 'payload', value: '' }] }] }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="param_payload"] .port-dot', { x: 200, y: 260 });
        await click(app, '#connection-create-popup [data-popup-node-type="Text"]');
        await app.waitFor("document.querySelectorAll('.node-text:not(.node-text-split)').length===1");
        const source = await app.evaluate("document.querySelector('.node-text').id");
        await assertConnected(app, source, 'target', 'param_payload');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: source, port: 'text' }, to: { nodeId: 'target', port: 'param_payload' } }]);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(saved=>saved.value.connections[0].type)"), 'text');
    });
});

test('a dynamic output removed while the create menu is open cannot leave an invalid edge or orphan node', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'source', type: 'TextSplit', x: 60, y: 260, outputCount: 3, text: 'one\n\ntwo\n\nthree' }] }, async app => {
        await dragFromPort(app, '#source .node-port[data-port="part_3"] .port-dot', { x: 620, y: 240 });
        await app.evaluate("const count=document.getElementById('source-output-count');count.value='1';count.dispatchEvent(new Event('input',{bubbles:true}))");
        await app.waitFor("!document.querySelector('#source .node-port[data-port=part_3]')");
        await click(app, '#connection-create-popup [data-popup-node-type="ImageGenerate"]');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer > .node').length"), 1, 'reject the stale source before creating a node');
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id]').length"), 0);
    });
});

test('a full reference input rejects creation before adding an orphan node and preserves every ordered edge', { timeout: 30000 }, async () => {
    const sources = Array.from({ length: 64 }, (_, index) => ({ id: `ref-${index}`, type: 'ImageImport', x: 1800, y: index * 400 }));
    const connections = sources.map((node, order) => ({ id: `ref-edge-${order}`, from: { nodeId: node.id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order }));
    await withAppBrowser({ ...session, nodes: [...sources, { id: 'target', type: 'ImageGenerate', x: 620, y: 260 }], connections }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="referenceImages"] .port-dot', { x: 200, y: 240 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageImport"]');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer > .node').length"), 65, 'no source node is created when the input is full');
        await savedConnections(app, 64);
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)"), connections);
    });
});

test('abandoning a drag from an already connected single input preserves the existing connection', { timeout: 30000 }, async () => {
    const edge = { id: 'existing', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' };
    await withAppBrowser({ ...session, nodes: [{ id: 'source', type: 'Text', x: 60, y: 260 }, { id: 'target', type: 'Text', x: 620, y: 260 }], connections: [edge] }, async app => {
        await dragFromPort(app, '#target .node-port[data-direction="input"] .port-dot', { x: 420, y: 600 }, false);
        assert.equal(await app.evaluate("Boolean(document.querySelector('path[data-conn-id=existing]')?.getAttribute('d'))"), true, 'an unfinished rewire must retain the old edge');
        await assertConnected(app, 'source', 'target', 'text', { connectionId: 'existing' });
        await savedConnections(app);
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)"), [edge]);
    });
});

test('a successful rewire replaces only its original edge and supports undo and redo', { timeout: 30000 }, async () => {
    const original = { id: 'existing', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' };
    await withAppBrowser({ ...session, nodes: [
        { id: 'source', type: 'Text', x: 60, y: 260 }, { id: 'target', type: 'Text', x: 620, y: 260 },
        { id: 'destination', type: 'Text', x: 620, y: 580 }
    ], connections: [original] }, async app => {
        await dragFromPort(app, '#target .node-port[data-direction="input"] .port-dot', await point(app, '#destination .node-port[data-direction="input"] .port-dot'), false);
        await app.waitFor("(async()=>{const s=await fetch('/api/storage/documents/session').then(r=>r.json());return s.value.connections.length===1&&s.value.connections[0].to.nodeId==='destination'})()");
        const current = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections[0])");
        await assertConnected(app, 'source', 'destination', 'text', { connectionId: current.id });
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
        await assertConnected(app, 'source', 'target', 'text', { connectionId: 'existing' });
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已重做上一步操作'))");
        await assertConnected(app, 'source', 'destination', 'text', { connectionId: current.id });
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id]').length"), 1);
    });
});

test('creating another reference source appends after existing sources and cancellation leaves their order intact', { timeout: 30000 }, async () => {
    const connections = retained.map(link => ({ ...link, to: { nodeId: 'target', port: 'referenceImages' } }));
    await withAppBrowser({ ...session, nodes: [...protectedNodes.slice(0, 2), { id: 'target', type: 'ImageGenerate', x: 620, y: 260 }], connections }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="referenceImages"] .port-dot', { x: 200, y: 240 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.getElementById('connection-create-popup').classList.contains('hidden')");
        assert.equal(await app.evaluate("document.querySelectorAll('#target-reference-sources .image-reference-group').length"), 2);
        await dragFromPort(app, '#target .node-port[data-port="referenceImages"] .port-dot', { x: 200, y: 240 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageImport"]');
        await savedConnections(app, 3);
        const links = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)");
        assert.deepEqual(links.slice(0, 2), connections);
        const added = links[2];
        assert.equal(added.order, 2);
        await assertConnected(app, added.from.nodeId, 'target', 'referenceImages', { connectionId: added.id });
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#target-reference-sources .image-reference-group')].map(p=>p.dataset.referenceConnection)"), links.map(link=>link.id));
    });
});

for (const [type, sourceType, prefix, mediaType] of [['ImageMerge', 'ImageImport', 'image', 'image'], ['TextMerge', 'Text', 'text', 'text']]) {
    test(`${type} creates from its dynamic third input and retains the first two source connections`, { timeout: 30000 }, async () => {
        const connections = ['a', 'b'].map((id, index) => ({ id: `input-${id}`, from: { nodeId: id, port: mediaType }, to: { nodeId: 'target', port: `${prefix}_${index + 1}` }, type: mediaType }));
        await withAppBrowser({ ...session, nodes: [
            { id: 'a', type: sourceType, x: 1800, y: 200 }, { id: 'b', type: sourceType, x: 1800, y: 600 },
            { id: 'target', type, x: 620, y: 260 }
        ], connections }, async app => {
            const port = `${prefix}_3`;
            await app.waitFor(`Boolean(document.querySelector('#target .node-port[data-port="${port}"]'))`);
            await dragFromPort(app, `#target .node-port[data-port="${port}"] .port-dot`, { x: 200, y: 240 });
            await click(app, `#connection-create-popup [data-popup-node-type="${sourceType}"]`);
            await savedConnections(app, 3);
            const links = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)");
            assert.deepEqual(links.slice(0, 2), connections);
            const added = links[2];
            assert.equal(added.to.port, port);
            await assertConnected(app, added.from.nodeId, 'target', port, { connectionId: added.id });
            assert.ok(await app.evaluate(`Boolean(document.querySelector('#target .node-port[data-port="${prefix}_4"]'))`), 'the next free dynamic input remains available');
        });
    });
}

test('a text split merged output can create a downstream node using its current output name', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'source', type: 'TextSplit', x: 60, y: 260, mergeOutputEnabled: true, text: 'one\n\ntwo' }] }, async app => {
        await dragFromPort(app, '#source .node-port[data-port="text"][data-direction="output"] .port-dot', { x: 620, y: 240 });
        await click(app, '#connection-create-popup [data-popup-node-type="Text"]');
        await savedConnections(app);
        const [link] = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(s=>s.value.connections)");
        assert.equal(link.from.port, 'text');
        await assertConnected(app, 'source', link.to.nodeId, 'text', { fromPort: 'text', connectionId: link.id });
    });
});
