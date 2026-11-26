import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser, waitForAutosave, reloadAppBrowser} from './helpers/app-browser.mjs';

test('running connections switch between animated arrows and static overview color', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'flow-source', type: 'Text', x: 80, y: 130 }, { id: 'flow-target', type: 'Text', x: 640, y: 220 }],
        connections: [{ id: 'flow-wire', from: { nodeId: 'flow-source', port: 'text' },
            to: { nodeId: 'flow-target', port: 'text' }, type: 'text' }]
    }, async app => {
        await app.evaluate(`(async () => {
            const { state, registry } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            window.setFlowRunning = running => {
                if (running) state.runningNodeIds.add('flow-source');
                else state.runningNodeIds.delete('flow-source');
                registry.connectionProjectionApi.interactions.nodeAppearanceChanged('flow-source');
            };
            window.flowPath = document.querySelector('#connections-group .connection-path');
            window.idleFlowStroke = getComputedStyle(flowPath).stroke;
            window.zoomFlow = zoom => { state.canvas.zoom = zoom; };
            window.flowArrow = () => document.querySelector(
                '[data-conn-flow-id="flow-wire"].active .connection-flow-arrow'
            );
            window.flowArrowTransform = () => flowArrow()?.getAttribute('transform');
            setFlowRunning(true);
        })()`);
        await app.waitFor("flowArrowTransform()?.startsWith('translate(')");
        await app.evaluate('window.firstFlowArrow = flowArrowTransform()');
        await app.waitFor('flowArrowTransform() && flowArrowTransform() !== firstFlowArrow');

        await app.evaluate('zoomFlow(0.1)');
        await app.waitFor("flowArrow() && getComputedStyle(flowArrow().parentElement).display === 'none'");
        await app.waitFor('getComputedStyle(flowPath).stroke === getComputedStyle(flowArrow()).stroke');
        await app.evaluate('window.overviewFlowArrow = flowArrowTransform(); zoomFlow(0.125)');
        await app.waitFor("flowArrow() && getComputedStyle(flowArrow().parentElement).display === 'block' && flowArrowTransform() !== overviewFlowArrow");

        await app.evaluate('zoomFlow(0.1)');
        await app.waitFor('getComputedStyle(flowPath).stroke === getComputedStyle(flowArrow()).stroke');
        await app.evaluate('setFlowRunning(false)');
        await app.waitFor("!document.querySelector('[data-conn-flow-id=flow-wire]')");
        await app.waitFor('getComputedStyle(flowPath).stroke === idleFlowStroke');
    });
});

test('temporary wire animation runs only while a path is drawn', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'wire-source', type: 'Text', x: 80, y: 120, text: 'Wire source' }], connections: [] }, async app => {
        const sample = () => app.evaluate(`(() => {
            const path = document.getElementById('temp-connection');
            return { animation: getComputedStyle(path).animationName,
                running: path.getAnimations().filter(animation => animation.playState === 'running').length };
        })()`);
        assert.deepEqual(await sample(), { animation: 'none', running: 0 }, 'an empty SVG path must not keep an animation ticking');
        await app.evaluate(`(async () => {
            const dot = document.querySelector('#wire-source .node-port[data-direction="output"] .port-dot');
            const rect = dot.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            dot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x + 100, clientY: y + 80 }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        assert.notEqual(await app.evaluate("document.getElementById('temp-connection').getAttribute('d')"), '');
        assert.deepEqual(await sample(), { animation: 'dash-flow', running: 1 }, 'drawing retains the moving dashed preview');
        await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
        assert.equal(await app.evaluate("document.getElementById('temp-connection').getAttribute('d')"), '');
        assert.deepEqual(await sample(), { animation: 'none', running: 0 }, 'finishing or cancelling releases the invisible animation');
    });
});

test('canvas compositor hints follow active gestures and release after settling', {timeout:30000}, async()=>{
    await withAppBrowser({autoCheckUpdatesOnLoad:false,nodes:[{id:'gpu-node',type:'Text',x:80,y:100,text:'Composited text'},{id:'gpu-offscreen',type:'Text',x:100000,y:100000,text:'Offscreen'}],connections:[]},async app=>{
        await app.evaluate(`(async()=>{const {state}=await(await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();window.gpuState=state;const h=document.querySelector('#gpu-node .node-header'),r=h.getBoundingClientRect();window.gpuPoint={x:r.left+25,y:r.top+15};window.gpuMouse=(type,dx=0)=>(type==='mousedown'?h:document).dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='mouseup'?0:1,clientX:gpuPoint.x+dx,clientY:gpuPoint.y}));})()`);
        const hints=()=>app.evaluate(`({node:getComputedStyle(document.getElementById('gpu-node')).willChange,layer:getComputedStyle(document.getElementById('nodes-layer')).willChange})`);
        assert.deepEqual(await hints(),{node:'auto',layer:'auto'});
        await app.evaluate("gpuMouse('mousedown');gpuMouse('mousemove',40);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
        assert.deepEqual(await hints(),{node:'transform',layer:'auto'});
        assert.equal(await app.evaluate("gpuState.nodes.get('gpu-node').x"),120);
        await app.evaluate("gpuMouse('mouseup',40)");
        await app.waitFor("!gpuState.dragging");
        assert.deepEqual(await hints(),{node:'auto',layer:'auto'});
        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:500,clientY:400,deltaY:-40}))`);
        assert.deepEqual(await hints(),{node:'transform',layer:'auto'});
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('gpu-offscreen')).willChange"),'auto');
        await app.waitFor("!document.getElementById('canvas-container').classList.contains('is-zooming')");
        assert.deepEqual(await hints(),{node:'auto',layer:'auto'});
        assert.ok(await app.evaluate('gpuState.canvas.zoom>1'));
    });
});

test('the first middle-button pan promotes the node layer only while the gesture is active', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'pan-node', type: 'Text', x: 80, y: 100, text: 'Panning' }], connections: [] }, async app => {
        const sample = () => app.evaluate(`(() => {
            const canvas = document.getElementById('canvas-container');
            return { hint: getComputedStyle(document.getElementById('nodes-layer')).willChange,
                panning: canvas.classList.contains('is-panning'), x: document.getElementById('pan-node').getBoundingClientRect().left };
        })()`);
        const start = { x: 505, y: 400 };
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
        await app.waitFor("document.getElementById('canvas-container').matches(':hover')");
        const ready = await sample();
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'middle', buttons: 4, ...start });
        const pressed = await sample();
        const moved = { x: start.x + 48, y: start.y - 23 };
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 4, ...moved });
        await app.waitFor(`document.getElementById('pan-node').getBoundingClientRect().left === ${ready.x + 48}`);
        const firstFrame = await sample();
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'middle', buttons: 0, ...moved });
        const released = await sample();

        assert.deepEqual([pressed.panning, firstFrame.panning, released.panning], [true, true, false]);
        assert.deepEqual([ready.hint, pressed.hint, firstFrame.hint, released.hint], ['auto', 'transform', 'transform', 'auto'],
            'the world layer is composited only for the gesture; promoting it outside panning rasterizes every card');
    });
});


test('GPU preference defaults on for old sessions, applies immediately and survives reload', {timeout:30000}, async()=>{
    await withAppBrowser({autoCheckUpdatesOnLoad:false,nodes:[{id:'gpu-node',type:'Text',x:80,y:100,text:'GPU setting'}],connections:[]},async app=>{
        const openSettings=()=>app.evaluate(`document.getElementById('btn-settings').click();document.getElementById('settings-tab-button-general').click()`);
        await openSettings();
        assert.equal(await app.evaluate("document.getElementById('setting-canvas-gpu-acceleration')?.checked"),true);
        await app.evaluate(`(async()=>{window.gpuSettingsApp=await(await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();window.gpuToggle=document.getElementById('setting-canvas-gpu-acceleration');window.setGpu=enabled=>{gpuToggle.checked=enabled;gpuToggle.dispatchEvent(new Event('change',{bubbles:true}))};})()`);
        await app.evaluate("document.getElementById('settings-close').click()");
        await app.evaluate(`const h=document.querySelector('#gpu-node .node-header'),r=h.getBoundingClientRect();window.dragPoint={x:r.left+25,y:r.top+15};h.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1,clientX:dragPoint.x,clientY:dragPoint.y}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:dragPoint.x+30,clientY:dragPoint.y}));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('gpu-node')).willChange"),'transform');
        await app.evaluate('setGpu(false)');
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('gpu-node')).willChange"),'auto');
        await app.evaluate(`document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:dragPoint.x+30,clientY:dragPoint.y}));setGpu(true);document.getElementById('canvas-container').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:1,buttons:4,clientX:500,clientY:400}))`);
        await app.evaluate(`document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:4,clientX:530,clientY:420}));new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        const panHints = () => app.evaluate(`['.canvas-grid', '#connections-svg'].map(selector => getComputedStyle(document.querySelector(selector)).willChange)`);
        assert.deepEqual(await panHints(), ['transform', 'transform']);
        await app.evaluate('setGpu(false)');
        assert.deepEqual(await panHints(), ['auto', 'auto']);
        assert.equal(await app.evaluate('gpuSettingsApp.state.canvas.isPanning'),true);
        await app.evaluate("window.dispatchEvent(new Event('blur'));setGpu(true)");
        assert.equal(await app.evaluate('gpuSettingsApp.state.canvas.isPanning'), false);
        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:500,clientY:400,deltaY:-40}));setGpu(false)`);
        assert.deepEqual(await app.evaluate(`({enabled:gpuSettingsApp.state.canvasGpuAccelerationEnabled,node:getComputedStyle(document.getElementById('gpu-node')).willChange,layer:getComputedStyle(document.getElementById('nodes-layer')).willChange})`),{enabled:false,node:'auto',layer:'auto'});
        await app.waitFor("!document.getElementById('canvas-container').classList.contains('is-zooming')");
        await waitForAutosave(app);
        assert.equal(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.canvasGpuAccelerationEnabled)"),false);
        await reloadAppBrowser(app);
        await openSettings();
        assert.equal(await app.evaluate("document.getElementById('setting-canvas-gpu-acceleration').checked"),false);
        await app.evaluate(`const toggle=document.getElementById('setting-canvas-gpu-acceleration');toggle.checked=true;toggle.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('canvas-container').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:500,clientY:400,deltaY:-40}));`);
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('gpu-node')).willChange"),'transform');
    });
});
