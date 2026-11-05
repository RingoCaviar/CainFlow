import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const types = ['ImageGenerate', 'ImageImport', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave', 'CameraControl'];
const reference = { id: 'image-edge', from: { nodeId: 'image-1', port: 'image' }, to: { nodeId: 'image-0', port: 'referenceImages' }, type: 'image', order: 0 };
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        ...types.map((type, index) => ({ collapsed: true, height: 40, collapsedExpandedHeight: 350, id: `image-${index}`, type, x: 500, y: 20, width: 320,
            ...(type === 'ImageSave' ? { customTitle: '保存成品' } : {}),
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

test('text cards select and drag before explicit editing, then Escape restores canvas interaction', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [{ id: 'text-card', type: 'Text', x: 80, y: 80, width: 260, height: 190, text: 'original draft' }], connections: [] }, async app => {
        const point = await app.evaluate("(()=>{const r=document.getElementById('text-card-text').getBoundingClientRect();return {x:r.left+40,y:r.top+40}})()");
        const mouse = (type, extra = {}) => app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, ...extra });
        await mouse('mousePressed'); await mouse('mouseReleased');
        assert.ok(await app.evaluate("document.getElementById('text-card').classList.contains('selected')&&document.activeElement!==document.getElementById('text-card-text')"), 'one click selects without entering the textarea');
        const before = await app.evaluate("document.getElementById('text-card').style.left");
        await mouse('mousePressed'); await mouse('mouseMoved', { x: point.x + 50, y: point.y + 30, buttons: 1 }); await mouse('mouseReleased', { x: point.x + 50, y: point.y + 30 });
        assert.notEqual(await app.evaluate("document.getElementById('text-card').style.left"), before, 'dragging the text surface moves the node');
        await mouse('mousePressed', { x: point.x + 50, y: point.y + 30, clickCount: 2 }); await mouse('mouseReleased', { x: point.x + 50, y: point.y + 30, clickCount: 2 });
        assert.ok(await app.evaluate("document.activeElement===document.getElementById('text-card-text')&&!document.getElementById('text-card-text').readOnly"), 'double click enters editing');
        await app.send('Input.insertText', { text: 'edited' });
        assert.ok(await app.evaluate("document.getElementById('text-card-text').value.includes('edited')"));
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        assert.ok(await app.evaluate("document.getElementById('text-card-text').readOnly&&!document.getElementById('text-card').classList.contains('is-text-editing')"));
    });
});

test('text node height remains stable across repeated zero-distance resize gestures', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [{ id: 'stable-text', type: 'Text', x: 80, y: 80, width: 260, height: 190, textareaHeights: {text: 188}, text: 'short text' }], connections: [] }, async app => {
        const heights = await app.evaluate("(async()=>{const node=document.getElementById('stable-text'),heights=[];node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:85,clientY:85}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));for(let i=0;i<12;i++){node.querySelector('.node-resize-handle--bottom-right').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:300,clientY:300}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:300,clientY:300}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));heights.push(node.offsetHeight)}return heights})()");
        assert.ok(Math.max(...heights)-Math.min(...heights)<=1, `zero-distance resize grows text node: ${heights.join(',')}`);
    });
});

test('compact editors retain nine node forms, original controls, prompt drafts and ordered connections', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        const emptyNames = ['图片生成', '图片导入', '图片预览', '缩放图片', '复位颜色', '图片对比', '多图合一', '保存成品'];
        for (const [index, name] of emptyNames.entries()) {
            assert.equal(await app.evaluate(`document.querySelector('#image-${index} .image-first-placeholder>span, #image-${index} .image-first-empty-name')?.textContent`), name);
        }
        assert.ok(await app.evaluate("(()=>{const e=document.querySelector('#image-7 .image-first-empty-name'),p=e.parentElement;const r=e.getBoundingClientRect(),s=p.getBoundingClientRect();return Math.abs((r.top+r.bottom-s.top-s.bottom)/2)<1&&getComputedStyle(e).justifyContent==='center'})()"), 'an empty save preview centers its custom node name');
        await app.evaluate("document.querySelector('#image-7 .save-preview-placeholder').textContent='本地视频缓存缺失；请确认后恢复原文件'");
        await settle(app);
        assert.equal(await app.evaluate("document.querySelector('#image-7 .save-preview-placeholder').classList.contains('image-first-empty-name')"), false, 'recovery details remain visible');
        await app.evaluate("document.querySelector('#image-7 .save-preview-placeholder').textContent='无输入图片'");
        await settle(app);
        assert.equal(await app.evaluate("document.querySelector('#image-7 .save-preview-placeholder').textContent"), '保存成品');
        await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(png)})).blob()],'reference.png',{type:'image/png'}));const input=document.getElementById('image-1-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.nodes.find(n=>n.id==='image-1')?.mediaAssetKeys?.length===1)");
        assert.ok(await app.evaluate("!!document.querySelector('#image-1-drop img')&&!document.querySelector('#image-1-drop .image-first-empty-name')"), 'an uploaded image replaces the name');
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        const geometry = await app.evaluate("[...document.querySelectorAll('#nodes-layer>.image-first-card')].map(n=>[n.id,n.style.left,n.style.top,n.offsetWidth])");

        const portGroups = await app.evaluate(`(()=>{return [...document.querySelectorAll('#nodes-layer>.image-first-card')].flatMap(node=>{const card=node.getBoundingClientRect();return [...node.querySelectorAll('.node-inputs-section,.node-outputs-section')].flatMap(section=>{const dots=[...section.querySelectorAll('.port-dot')].filter(dot=>dot.getClientRects().length).map(dot=>dot.getBoundingClientRect());if(!dots.length)return [];return [{id:node.id,vertical:(dots[0].top+dots.at(-1).bottom-card.top-card.bottom)/2,horizontal:dots.map(dot=>(dot.left+dot.right)/2-(section.classList.contains('node-inputs-section')?card.left:card.right))}]})})})()`);
        assert.ok(portGroups.length >= 9);
        for (const group of portGroups) {
            assert.ok(Math.abs(group.vertical) < 1, `${group.id} port group is vertically centered`);
            assert.ok(group.horizontal.every(offset=>Math.abs(offset)<1), `${group.id} ports retain their horizontal shell seams`);
        }
        const alignment = await app.evaluate(`(()=>{const path=document.querySelector('[data-conn-id=image-edge]'),matrix=path.getScreenCTM();return [[path.getPointAtLength(0).matrixTransform(matrix),document.querySelector('#image-1 .node-port.output .port-dot')],[path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix),document.querySelector('#image-0 .universal-input .port-dot')]].map(([point,dot])=>{const r=dot.getBoundingClientRect();return Math.hypot(point.x-(r.left+r.right)/2,point.y-(r.top+r.bottom)/2)})})()`);
        assert.ok(alignment.every(distance=>distance<1), 'connections follow the centered image ports');
        assert.equal(await app.evaluate("document.querySelectorAll('.node-collapse-btn,.node.collapsed,.node-body.is-collapsed').length"), 0);
        assert.ok(await app.evaluate("(()=>{const n=document.getElementById('text-source'),t=n.querySelector('textarea'),s=getComputedStyle(t),g=getComputedStyle(n.querySelector('.node-glass-bg'));return s.borderTopStyle==='none'&&parseFloat(s.fontSize)>=14&&g.boxShadow==='none'&&g.backgroundColor!=='rgba(0, 0, 0, 0)'})()"), 'text editors share the unframed opaque theme surface and readable type');
        assert.ok(await app.evaluate("(()=>{const n=document.getElementById('text-source'),r=n.getBoundingClientRect(),t=n.querySelector('textarea').getBoundingClientRect();return [...n.querySelectorAll('.port-dot')].every(dot=>{const d=dot.getBoundingClientRect();return Math.abs((d.top+d.bottom-r.top-r.bottom)/2)<1})&&[...n.querySelectorAll('.port-label')].every(label=>!label.checkVisibility())&&Math.abs(t.top-r.top)<=2})()"), 'text ports center on the shell with no label strip above the editable content');
        await app.evaluate("document.querySelector('#text-source .node-header').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))");
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
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel > .image-parameter-footer').contains(document.getElementById('image-0-generation-count'))"), true, 'the original count stays in the fixed action bar');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=model]').textContent"), '模型 · 受控图片');
        await app.evaluate('getSelection().removeAllRanges()');
        const modelButton = await app.evaluate("(()=>{const r=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=model]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
        for (const clickCount of [1, 2]) {
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...modelButton, button: 'left', clickCount });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...modelButton, button: 'left', clickCount });
        }
        assert.equal(await app.evaluate('getSelection().toString()'), '', 'real double click does not select the model button label');
        assert.ok(await app.evaluate("[...document.querySelectorAll('#image-parameter-panel button,#image-parameter-panel summary,#toolbar button')].every(e=>getComputedStyle(e).userSelect==='none')"));
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('image-0-prompt')).userSelect"), 'text');

        assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),c=document.querySelector('#image-parameter-panel .image-parameter-count-slot').getBoundingClientRect(),g=document.querySelector('#image-parameter-panel [data-parameter-action=generate]').getBoundingClientRect();return g.right<=p.right-12&&g.right>=p.right-20&&c.right<=g.left&&g.left-c.right<=12})()"), 'count and generate controls align together at the right edge');

        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=reference]').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('#image-0-reference-sources .image-reference-more, #image-0-reference-sources .image-reference-source-actions, #image-0-reference-sources .image-reference-source-status').length"), 0);

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
        const textBounds = await app.evaluate("(()=>{const e=originalCompactPrompt,s=getComputedStyle(e),r=e.getBoundingClientRect(),b=document.querySelector('#image-parameter-panel .image-parameter-tools').getBoundingClientRect();return {right:parseFloat(s.paddingRight),left:parseFloat(s.paddingLeft),textBottom:r.bottom,toolsTop:b.top,topPadding:parseFloat(s.paddingTop)}})()");
        assert.ok(Math.abs(textBounds.right - textBounds.left) <= 1, 'prompt uses the full width with balanced side padding');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-header').checkVisibility()"), false, 'parameter editors have no title bar or corner tools');
        assert.ok(textBounds.topPadding <= 10, 'prompt no longer reserves a toolbar row');
        await app.evaluate("document.querySelector('#image-parameter-panel .image-prompt-actions').scrollIntoView({block:'end'})");
        await settle(app);
        const assistantBounds = await app.evaluate("(()=>{const b=document.getElementById('image-0-assistant'),p=originalCompactPrompt,s=getComputedStyle(p);return {ownRow:b.closest('.image-prompt-actions').previousElementSibling===p.closest('.image-node-prompt-field'),settingsTop:document.querySelector('#image-parameter-panel .image-parameter-setting-bar').getBoundingClientRect().top,actionBottom:b.getBoundingClientRect().bottom,top:b.getBoundingClientRect().top,bottom:p.getBoundingClientRect().bottom,padding:parseFloat(s.paddingBottom)}})()");
        assert.ok(assistantBounds.ownRow && assistantBounds.top >= assistantBounds.bottom && assistantBounds.top - assistantBounds.bottom <= 10, 'assistant action is directly below the textarea');
        assert.ok(assistantBounds.settingsTop >= assistantBounds.actionBottom, 'settings follow the independent prompt action row');
        assert.ok(assistantBounds.padding <= 10, 'textarea reserves no bottom button space');
        assert.ok(await app.evaluate("(()=>{const prompt=document.querySelector('#image-parameter-panel .image-node-prompt-field'),model=document.querySelector('#image-parameter-panel .image-parameter-model-entry');return Boolean(prompt.compareDocumentPosition(model)&Node.DOCUMENT_POSITION_FOLLOWING)})()"), 'model settings follow the prompt');
        assert.ok(automatic.font >= 13);
        assert.ok(automatic.height >= automatic.line * 5 + automatic.padding);
        assert.ok(automatic.height <= automatic.line * 8 + automatic.padding + 3);
        await app.evaluate("originalCompactPrompt.style.height='260px';originalCompactPrompt.value='short';originalCompactPrompt.dispatchEvent(new Event('input',{bubbles:true}))");
        await settle(app);
        assert.equal(await app.evaluate('originalCompactPrompt.style.height'), '260px', 'typing respects a manually set editor height');

        for (const [index, type] of types.entries()) {
            await open(app, `image-${index}`);
            await settle(app);
            const measurements = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),s=p.querySelector('.image-parameter-scroll'),h=p.querySelector('.image-parameter-header');return {type:p.dataset.nodeType,height:p.offsetHeight,header:h.checkVisibility(),overflow:s.scrollWidth-s.clientWidth,footerHidden:p.querySelector('.image-parameter-footer').hidden}})()");
            assert.equal(measurements.type, type);
            assert.equal(measurements.header, false, `${type} has no visible title bar`);
            assert.ok(measurements.overflow <= 1, `${type} does not overflow horizontally`);
            if (type === 'ImageImport') {
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), false);
                await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
                assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal');
                assert.equal(measurements.footerHidden, true); assert.ok(measurements.height < 220);
                const alignment = await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),m=document.querySelector('#image-parameter-panel .image-import-mode-shell').getBoundingClientRect(),c=document.querySelector('#image-parameter-panel [data-parameter-action=close]').getBoundingClientRect();return {width:p.width,offset:Math.abs((m.left+m.right-p.left-p.right)/2),clear:m.right<=c.left-4&&m.left>=p.left+8}})()");
                assert.ok(alignment.width <= 280); assert.ok(alignment.offset<=1, 'import mode controls stay centered without a title strip');
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
                assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel .image-camera-help,#image-parameter-panel .image-camera-state-summary').length"), 0);
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), false);
                assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel .image-camera-prompt-details').checkVisibility()"));
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '编辑视角');
            }
            if (type === 'ImageSave') {
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), false);
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').checkVisibility()"), false);
                assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-save-preview-tools').checkVisibility()"), false);
                assert.equal(await app.evaluate("document.querySelector('#image-7 .save-btn-group')===null"), true);
                assert.ok(await app.evaluate("document.querySelector('#image-parameter-panel #image-7-manual-save').checkVisibility()&&document.querySelector('#image-parameter-panel #image-7-view-full').checkVisibility()"));
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
        await open(app, 'image-8');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal');
        await open(app, 'image-1');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal', 'switching from an expanded node restores the compact import mode');
        await open(app, 'image-0');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').checkVisibility()"), false);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'expanded');
        await app.evaluate("document.querySelectorAll('.toast').forEach(toast=>toast.remove());document.querySelectorAll('#canvas-navigation details[open]').forEach(menu=>menu.open=false);document.getElementById('image-0-assistant').click()");
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        for (const width of [1100, 600, 360]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
            await app.evaluate("document.getElementById('prompt-agent-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))");
            await settle(app);
            await app.evaluate("document.querySelectorAll('.toast').forEach(toast=>toast.remove())");
            const bounds = await app.evaluate(`(()=>{const s=document.querySelector('.image-panel-switcher').getBoundingClientRect(),a=document.getElementById('prompt-agent-panel').getBoundingClientRect(),n=document.getElementById('canvas-navigation').getBoundingClientRect();return {left:s.left,right:s.right,agent:a.left,bottom:s.bottom,top:s.top,navigation:!(s.left<n.right&&s.right>n.left&&s.top<n.bottom&&s.bottom>n.top),buttons:[...document.querySelectorAll('.image-panel-switcher button')].every(b=>{const r=b.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===b})}})()`);
            assert.ok(bounds.left >= 0 && bounds.right <= bounds.agent, `${width}: switcher clears the Agent: ${JSON.stringify(bounds)}`);
            assert.ok(bounds.top >= 0 && bounds.bottom <= 820 && bounds.navigation && bounds.buttons, `${width}: both entries remain reachable outside canvas navigation: ${JSON.stringify(bounds)}`);
        }
        await app.evaluate("document.getElementById('btn-close-prompt-agent').click()");
        await settle(app);
        assert.equal(await app.evaluate("document.querySelector('.image-panel-switcher').classList.contains('is-stacked')"), false);
    });
});


test('legacy automatic saves display their own name while ordinary custom names survive reload', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { id: 'legacy-save', type: 'ImageSave', customTitle: '图片生成 · 保存', autoAddedForGeneration: true },
        { id: 'named-save', type: 'ImageSave', customTitle: '我的成品' },
        { id: 'other-auto-save', type: 'ImageSave', customTitle: '海报 · 保存', autoAddedForGeneration: true }
    ], connections: [] }, async app => {
        for (let reload = 0; reload < 2; reload++) {
            for (const [id, name] of [['legacy-save', '保存节点'], ['named-save', '我的成品'], ['other-auto-save', '保存节点']]) {
                assert.equal(await app.evaluate(`document.querySelector('#${id} .image-first-empty-name')?.textContent`), name);
                assert.equal(await app.evaluate(`document.querySelector('#${id} .node-title').textContent`), name);
                await open(app, id);
                assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').getAttribute('aria-label')"), `${name} · 节点参数浮层`);
            }
            if (!reload) await reloadAppBrowser(app);
        }
    });
});
