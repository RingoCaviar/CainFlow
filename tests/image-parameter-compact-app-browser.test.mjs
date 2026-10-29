import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const types = ['ImageGenerate', 'ImageImport', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave', 'CameraControl'];
const reference = { id: 'image-edge', from: { nodeId: 'image-1', port: 'image' }, to: { nodeId: 'image-0', port: 'referenceImages' }, type: 'image', order: 0 };
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        ...types.map((type, index) => ({ collapsed: true, height: 40, collapsedExpandedHeight: 350, id: `image-${index}`, type, x: 500, y: 20, width: 320,
            ...(type === 'ImageGenerate' ? { apiConfigId: 'image', providerId: 'p', prompt: 'preserved local draft', generationCount: 1 } : {}) })),
        { id: 'text-source', type: 'Text', x: 80, y: 20, text: 'effective upstream prompt', collapsed: true, height: 35, collapsedExpandedHeight: 240 }
    ],
    connections: [reference, { id: 'prompt-edge', from: { nodeId: 'text-source', port: 'text' }, to: { nodeId: 'image-0', port: 'prompt' }, type: 'text' }]
};

async function open(app, id) {
    await app.evaluate(`document.getElementById('${id}').click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.dataset.nodeId==='${id}'&&!document.getElementById('image-parameter-panel').hidden`);
}

const settle = app => app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

test('compact editors retain nine node forms, original controls, prompt drafts and ordered connections', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(png)})).blob()],'reference.png',{type:'image/png'}));const input=document.getElementById('image-1-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.nodes.find(n=>n.id==='image-1')?.mediaAssetKeys?.length===1)");
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        const geometry = await app.evaluate("[...document.querySelectorAll('#nodes-layer>.image-first-card')].map(n=>[n.id,n.style.left,n.style.top,n.offsetWidth])");

        assert.equal(await app.evaluate("document.querySelectorAll('.node-collapse-btn,.node.collapsed,.node-body.is-collapsed').length"), 0);
        await app.evaluate("document.querySelector('#text-source .node-header').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
        assert.equal(await app.evaluate("document.querySelector('#text-source .node-body').checkVisibility()"), true);
        await open(app, 'image-0');
        assert.equal(await app.evaluate("document.querySelector('#image-0 .image-first-summary')===null"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-first-summary')===null"), true);
        assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=reference]').textContent.includes('1')"));
        assert.ok(await app.evaluate("!!document.querySelector('#image-parameter-panel [data-image-generation-dirty]')"));
        assert.equal(await app.evaluate("document.querySelector('#image-0-prompt-source details').open"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-0-prompt-field .image-local-prompt-draft').open"), false);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]')===null"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-node-run-status').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-run-feedback').checkVisibility()"), false);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-image-run-action=details]').hidden=false");
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-run-feedback').checkVisibility()"), true);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-image-run-action=details]').hidden=true");
        assert.equal(await app.evaluate("document.getElementById('image-0-prompt').value"), 'preserved local draft');
        assert.ok(await app.evaluate("document.getElementById('image-0-prompt-source').textContent.includes('effective upstream prompt')"));
        await app.evaluate("window.originalCompactPrompt=document.getElementById('image-0-prompt');document.querySelector('#image-parameter-panel .generation-count-btn[data-delta=\"1\"]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.nodes.find(n=>n.id==='image-0')?.generationCount===2)");
        assert.equal(await app.evaluate("document.querySelector('#image-0-prompt-field').parentElement.contains(document.getElementById('image-0-generation-count'))"), true, 'the original count remains in its node parameter root');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=model]').textContent"), '受控图片');
        assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),c=document.querySelector('#image-parameter-panel .image-parameter-count-slot').getBoundingClientRect(),g=document.querySelector('#image-parameter-panel [data-parameter-action=generate]').getBoundingClientRect();return Math.abs((c.left+g.right)/2-(p.left+p.width/2))<1})()"), 'count and generate controls are centered together');

        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=reference]').click()");
        assert.equal(await app.evaluate("document.querySelector('#image-0-reference-sources .image-reference-more').open"), false);
        await app.evaluate("document.querySelector('#image-0-reference-sources .image-reference-more>summary').click()");
        assert.equal(await app.evaluate("document.querySelector('#image-0-reference-sources .image-reference-more').open"), true);
        assert.ok(await app.evaluate("document.querySelector('#image-0-reference-sources .image-reference-disconnect').textContent.includes('1')"));

        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=advanced]').click()");
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-input-detail')===null"), true);
        assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel .node-advanced-parameters').checkVisibility()"));
        assert.deepEqual((await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections)")).map(edge=>edge.id), [reference.id,'prompt-edge']);
        await app.evaluate("document.querySelector('#text-source .node-delete').click()");
        await app.waitFor("!document.querySelector('#image-0-prompt-field .image-local-prompt-draft')&&!document.getElementById('image-0-prompt').readOnly");
        assert.equal(await app.evaluate("document.getElementById('image-0-prompt')===originalCompactPrompt&&originalCompactPrompt.value==='preserved local draft'"), true);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.connections.length===1)");
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections)"), [reference], 'deleting the prompt source never disconnects its image reference');

        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=advanced]').click();originalCompactPrompt.value=Array(14).fill('long prompt line').join('\\n');originalCompactPrompt.dispatchEvent(new Event('input',{bubbles:true}))");
        await settle(app);
        const automatic = await app.evaluate("(()=>{const e=originalCompactPrompt,s=getComputedStyle(e);return {height:e.offsetHeight,line:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),font:parseFloat(s.fontSize)}})()");
        assert.ok(automatic.font >= 13);
        assert.ok(automatic.height >= automatic.line * 3 + automatic.padding);
        assert.ok(automatic.height <= automatic.line * 6 + automatic.padding + 3);
        await app.evaluate("originalCompactPrompt.style.height='260px';originalCompactPrompt.value='short';originalCompactPrompt.dispatchEvent(new Event('input',{bubbles:true}))");
        await settle(app);
        assert.equal(await app.evaluate('originalCompactPrompt.style.height'), '260px', 'typing respects a manually set editor height');

        for (const [index, type] of types.entries()) {
            await open(app, `image-${index}`);
            await settle(app);
            const measurements = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),s=p.querySelector('.image-parameter-scroll'),h=p.querySelector('.image-parameter-header');return {type:p.dataset.nodeType,height:p.offsetHeight,header:getComputedStyle(h).position,overflow:s.scrollWidth-s.clientWidth,footerHidden:p.querySelector('.image-parameter-footer').hidden}})()");
            assert.equal(measurements.type, type);
            assert.equal(measurements.header, 'absolute');
            assert.ok(measurements.overflow <= 1, `${type} does not overflow horizontally`);
            if (type === 'ImageImport') {
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), false);
                await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
                assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal');
                assert.equal(measurements.footerHidden, true); assert.ok(measurements.height < 64);
                const alignment = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),m=document.querySelector('#image-parameter-panel .image-import-mode-shell').getBoundingClientRect();return {width:p.width,offset:Math.abs(m.left+m.width/2-p.left-p.width/2)}})()");
                assert.ok(alignment.width <= 200); assert.ok(alignment.offset <= 1);
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-first-summary').checkVisibility()"), false);
                await app.evaluate("document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=url]').click()");
                await settle(app);
                assert.ok(await app.evaluate("document.getElementById('image-parameter-panel').offsetWidth >= 280"));
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-import-url-fields').hidden"), false);
                assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel .image-import-url-fields input').checkVisibility()"));
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-first-summary').checkVisibility()"), false);
                await app.evaluate("document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=upload]').click()");
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-import-url-fields').hidden"), true);
            }
            if (type === 'ImageImport' || type === 'ImageSave') {
                assert.equal(await app.evaluate(`!!document.querySelector('#image-${index} .image-first-summary')`), false, `${type} keeps metadata off the card`);
                assert.ok(await app.evaluate("!!document.querySelector('#image-parameter-panel .image-first-summary')"));
            }
            if (type === 'CameraControl') {
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .camera-control-note').checkVisibility()"), false);
                await app.evaluate("document.querySelector('#image-parameter-panel .image-camera-help>summary').click()");
                assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel .camera-control-note').checkVisibility()"));
                assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel .image-camera-state-summary dd').length"), 6);
            }
            if (type === 'ImageSave') {
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-first-summary').checkVisibility()"), false);
                assert.equal(await app.evaluate("document.querySelector('#image-7-save-preview .image-save-preview-tools')===null"), true);
                assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel .image-save-preview-tools').length"), 1, 'the original image/video controls exist once inside parameters');
            }
        }
        await open(app, 'image-0');
        assert.ok(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.every(n=>!('collapsed' in n)&&!('collapsedExpandedHeight' in n)))"));
        assert.equal(await app.evaluate("document.getElementById('image-0-generation-count').value"), '2');
        assert.equal(await app.evaluate('document.getElementById("image-0-prompt")===originalCompactPrompt'), true);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#nodes-layer>.image-first-card')].map(n=>[n.id,n.style.left,n.style.top,n.offsetWidth])"), geometry);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click();document.querySelector('#image-parameter-panel [data-parameter-group-toggle=advanced]').click()");
        await settle(app);
        assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),b=document.querySelector('#image-parameter-panel [data-parameter-action=generate]').getBoundingClientRect();return b.top>=p.top&&b.bottom<=p.bottom+1})()"), 'expanded long settings keep the primary action reachable');
        await open(app, 'image-1');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal', 'switching from an expanded node restores the compact import mode');
        await open(app, 'image-0');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), true);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'expanded');
    });
});
