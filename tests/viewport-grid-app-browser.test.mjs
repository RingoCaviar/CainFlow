import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAppBrowser, waitForAutosave, withAppBrowser } from './helpers/app-browser.mjs';

test('middle pan keeps wires aligned across the raster margin and restores only the viewport after reload', { timeout: 45000 }, async () => {
    const reference = { name: 'reference', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024) };
    const workflow = { workflowId: 'wire-pan', canvas: { x: 20, y: -10, zoom: .75 },
        nodes: [{ id: 'source', type: 'Text', x: 80, y: 160 }, { id: 'dest', type: 'Text', x: 680, y: 210 }],
        connections: [{ id: 'pan-edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'dest', port: 'text' }, type: 'text' }],
        promptAgent: { messages: [{ role: 'user', text: 'reference', referenceImages: [reference] }] }
    };
    await withAppBrowser({ ...workflow, autoCheckUpdatesOnLoad: false, activeWorkflowId: workflow.workflowId, activeWorkflowName: 'Pan',
        workflowTabs: [{ name: 'Pan', workflowId: workflow.workflowId, data: workflow }]
    }, async app => {
        await waitForAutosave(app);
        const writes = [];
        const stop = app.onProtocolEvent(({ method, params }) => {
            const request = params?.request;
            if (method === 'Network.requestWillBeSent' && request.method !== 'GET') writes.push(new URL(request.url).pathname);
        });
        await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            window.panOrigin = { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom };
            window.panSample = () => {
                const path = document.querySelector('[data-conn-id="pan-edge"]');
                const dot = document.querySelector('#source .node-port.output .port-dot').getBoundingClientRect();
                const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
                const svg = path.ownerSVGElement, bounds = svg.getBoundingClientRect(), view = svg.parentElement.getBoundingClientRect();
                return { error: Math.hypot(start.x - dot.x - dot.width / 2, start.y - dot.y - dot.height / 2),
                    covers: bounds.left <= view.left && bounds.top <= view.top && bounds.right >= view.right && bounds.bottom >= view.bottom,
                    hint: getComputedStyle(svg).willChange, group: path.parentElement.getAttribute('transform'),
                    anchorOnPath: getComputedStyle(path).getPropertyValue('--wire-anchor') };
            };
        })()`);
        const start = { x: 505, y: 590 };
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'middle', buttons: 4, ...start });
        let lastGroup;
        for (const dx of [-60, -95, 280, 255]) {
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 4, x: start.x + dx, y: start.y - 50 });
            await app.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
            const sample = await app.evaluate('panSample()');
            assert.ok(sample.error < .25 && sample.covers, JSON.stringify(sample));
            assert.equal(sample.hint, 'transform');
            assert.equal(sample.anchorOnPath, '', 'individual wires do not inherit the raster anchor');
            if (lastGroup !== undefined) assert.equal(sample.group, lastGroup, 'panning must reuse painted paths');
            lastGroup = sample.group;
        }
        const releaseDx = 267;
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'middle', buttons: 0, x: start.x + releaseDx, y: start.y - 50 });
        const idle = await app.evaluate('panSample()');
        assert.ok(idle.error < .25 && idle.covers);
        assert.equal(idle.hint, 'auto');
        const expected = await app.evaluate(`({ x: panOrigin.x + ${releaseDx}, y: panOrigin.y - 50, zoom: panOrigin.zoom })`);
        await app.waitFor(`fetch('/api/storage/documents/viewport_state').then(r=>r.json()).then(r=>r.value?.['wire-pan']?.x === ${expected.x})`);
        await waitForAutosave(app);
        stop();
        assert.ok(writes.includes('/api/storage/documents/viewport_state'));
        assert.ok(!writes.some(path => path === '/api/storage/documents/session' || path.startsWith('/api/workflows/')), JSON.stringify(writes));
        await reloadAppBrowser(app);
        assert.deepEqual(await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const { x, y, zoom } = state.canvas;
            return { x, y, zoom };
        })()`), expected);
    });
});

test('wires stay attached when another pan starts before the previous settlement frame', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        canvas: { x: 20, y: -10, zoom: .75 },
        nodes: [{ id: 'rapid-source', type: 'Text', x: 80, y: 160 }, { id: 'rapid-dest', type: 'Text', x: 680, y: 210 }],
        connections: [{ id: 'rapid-edge', from: { nodeId: 'rapid-source', port: 'text' },
            to: { nodeId: 'rapid-dest', port: 'text' }, type: 'text' }]
    }, async app => {
        await app.waitFor("document.querySelector('[data-conn-id=rapid-edge]')?.getAttribute('d')");
        const result = await app.evaluate(`(async () => {
            const canvas = document.getElementById('canvas-container');
            const mouse = (target, type, x, buttons) => target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, button: 1, buttons, clientX: x, clientY: 590
            }));
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const sample = () => {
                const path = document.querySelector('[data-conn-id=rapid-edge]');
                const port = document.querySelector('#rapid-source .node-port.output .port-dot').getBoundingClientRect();
                const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
                return { x: port.left, error: Math.hypot(start.x - port.left - port.width / 2, start.y - port.top - port.height / 2) };
            };
            mouse(canvas, 'mousedown', 505, 4);
            mouse(document, 'mousemove', 565, 4);
            await paint();
            const first = sample();
            // The next move reaches the viewport before the queued alignment check.
            mouse(document, 'mouseup', 565, 0);
            mouse(canvas, 'mousedown', 505, 4);
            mouse(document, 'mousemove', 655, 4);
            await paint();
            const second = sample();
            mouse(document, 'mouseup', 655, 0);
            await paint();
            return { first, second, settled: sample() };
        })()`);
        assert.equal(result.second.x, result.first.x + 150);
        for (const sample of Object.values(result)) {
            assert.ok(sample.error < .25, JSON.stringify(result));
        }
    });
});

test('the grid stays anchored through long-frame protection during middle-button and space pans', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        canvas: { x: 11, y: -19, zoom: .75 },
        nodes: [{ id: 'pan-grid-node', type: 'Text', x: 100, y: 100, text: 'Pan' }],
        connections: []
    }, async app => {
        const start = { x: 505, y: 500 };
        const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 };
        const canvas = "document.getElementById('canvas-container')";
        const protectedMode = `${canvas}.classList.contains('canvas-performance-protected')`;
        const sampleGrid = () => app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const canvas = ${canvas};
            const grid = canvas.querySelector(':scope > .canvas-grid');
            const view = canvas.getBoundingClientRect(), bounds = grid.getBoundingClientRect();
            const style = getComputedStyle(grid);
            const spacing = parseFloat(style.backgroundSize);
            const phaseError = delta => Math.abs(delta - Math.round(delta / spacing) * spacing);
            return {
                x: state.canvas.x, y: state.canvas.y,
                errorX: phaseError(bounds.left - view.left + parseFloat(style.backgroundPositionX) - state.canvas.x),
                errorY: phaseError(bounds.top - view.top + parseFloat(style.backgroundPositionY) - state.canvas.y),
                protected: ${protectedMode}
            };
        })()`);
        const settlePaint = () => app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const samplesByButton = [];
        for (const [button, buttons] of [['middle', 4], ['left', 1]]) {
            const move = async (dx, dy) => {
                await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons, x: start.x + dx, y: start.y + dy });
                await settlePaint();
            };
            const origin = await sampleGrid();
            if (button === 'left') await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...space });
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, buttons, ...start });
            await move(73, -49);
            const before = await sampleGrid();
            assert.equal(before.x, origin.x + 73, `${button} pan moved the viewport`);
            assert.equal(before.y, origin.y - 49);
            // Force two missed frame deadlines in the real performance guard.
            await app.evaluate(`new Promise(resolve => {
                let delays = 2;
                requestAnimationFrame(function stall() {
                    const end = performance.now() + 80;
                    while (performance.now() < end) {}
                    requestAnimationFrame(--delays ? stall : resolve);
                });
            })`);
            await app.waitFor(protectedMode);
            const protectedAtRest = await sampleGrid();
            await move(128, -81);
            const moving = await sampleGrid();
            assert.equal(protectedAtRest.protected, true);
            assert.equal(moving.protected, true);
            assert.equal(moving.x, origin.x + 128, `${button} pan keeps moving with protection on`);
            assert.equal(moving.y, origin.y - 81);
            const samples = [before, protectedAtRest, moving];
            if (button === 'middle') {
                await app.waitFor(`!${protectedMode}`);
                samples.push(await sampleGrid());
            }
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, buttons: 0, x: start.x + 128, y: start.y - 81 });
            if (button === 'left') await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
            await settlePaint();
            samples.push(await sampleGrid());
            samplesByButton.push({ button, samples });
        }
        for (const { button, samples } of samplesByButton) {
            for (const sample of samples) {
                assert.ok(sample.errorX < .02 && sample.errorY < .02, `${button} grid lost its world position: ${JSON.stringify(sample)}`);
            }
        }
    });
});

test('the real canvas grid follows the public viewport across themes without moving ports or intercepting input', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
        nodes: [{ id: 'canvas-grid', type: 'Text', x: 100, y: 100, width: 240, text: 'source' },
            { id: 'target', type: 'Text', x: 500, y: 100, width: 240, text: 'target' }],
        connections: [{ id: 'edge', from: { nodeId: 'canvas-grid', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' }]
    }, async app => {
        // During a held pan the gradient stays painted in place on its own layer.
        // Only the tile phase moves, including for negative world coordinates.
        const panSamples = await app.evaluate(`(async () => {
            const canvas = document.getElementById('canvas-container');
            const grid = canvas.querySelector(':scope > .canvas-grid');
            const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, button: 1, buttons: type === 'mouseup' ? 0 : 4,
                clientX: x, clientY: y
            }));
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const origin = { ...state.canvas };
            mouse(canvas, 'mousedown', 500, 350);
            const result = [];
            for (const [dx, dy] of [[-143, 79], [85, -126]]) {
                const applied = new Promise(resolve => document.addEventListener('cainflow:canvas-pan-frame', resolve, { once: true }));
                mouse(document, 'mousemove', 500 + dx, 350 + dy);
                await applied;
                const style = getComputedStyle(grid);
                const viewport = canvas.getBoundingClientRect(), bounds = grid.getBoundingClientRect();
                result.push({ position: style.backgroundPosition, spacing: parseFloat(style.backgroundSize),
                    dx: bounds.left - viewport.left - origin.x - dx, dy: bounds.top - viewport.top - origin.y - dy,
                    covers: bounds.left <= viewport.left && bounds.top <= viewport.top &&
                        bounds.right >= viewport.right && bounds.bottom >= viewport.bottom });
            }
            mouse(document, 'mousemove', 500, 350);
            mouse(document, 'mouseup', 500, 350);
            return result;
        })()`);
        for (const sample of panSamples) {
            assert.equal(sample.position, '0px 0px', 'panning must not repaint the gradient at a new background position');
            assert.ok(sample.covers, 'the grid covers every viewport edge');
            for (const delta of [sample.dx, sample.dy]) {
                assert.ok(Math.abs(delta / sample.spacing - Math.round(delta / sample.spacing)) < .001,
                    'the moving grid stays in phase with the world origin');
            }
        }
        const port = await app.evaluate(`(()=>{const dot=document.querySelector('#canvas-grid .node-port.output .port-dot'),r=dot.getBoundingClientRect();return {x:r.x+r.width*.75,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
        assert.ok(Math.abs(port.width - 36.4) < .02);
        assert.ok(Math.abs(port.height - 36.4) < .02);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: port.x, y: port.y });
        assert.deepEqual(await app.evaluate(`(()=>{const dot=document.querySelector('#canvas-grid .node-port.output .port-dot'),r=dot.getBoundingClientRect(),css=getComputedStyle(dot);return {hover:dot.matches(':hover'),width:r.width,height:r.height,transform:css.transform,transition:css.transitionProperty,hit:document.elementFromPoint(${port.x},${port.y})===dot}})()`),
            { hover: true, width: port.width, height: port.height, transform: 'none', transition: 'box-shadow', hit: true }, 'hover keeps the enlarged port stable and reachable');
        const samples = await app.evaluate(`(async()=>{
            const {createViewportApi}=await import('/js/canvas/viewport.js');
            const {createElements}=await import('/js/core/elements.js');
            const {createThemeControllerApi}=await import('/js/features/ui/theme-controller.js');
            const elements=createElements(document),state={canvas:{x:0,y:0,zoom:1}};
            const api=createViewportApi({state,elements,updateAllConnections(){}});
            const theme=createThemeControllerApi({state:{},onThemeApplied:()=>api.refreshCanvasThemeMetrics()});
            const center=element=>{const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}};
            const legacyNode=document.getElementById('canvas-grid');
            const path=document.querySelector('[data-conn-id=edge]'),source=legacyNode.querySelector('.node-port[data-direction=output] .port-dot'),target=document.querySelector('#target .node-port[data-direction=input] .port-dot');
            const result=[];
            for(const themeId of ['dark','pro','paper','light','glass-light','glass-dark','pink']){
                theme.applyTheme(themeId);
                const background=getComputedStyle(elements.canvasContainer).backgroundImage;
                const baseSpacing=parseFloat(getComputedStyle(elements.canvasContainer).getPropertyValue('--canvas-dot-spacing'));
                for(const zoom of [.5,1,1.5])for(const protectedMode of [false,true]){
                    Object.assign(state.canvas,{x:37,y:-19,zoom});
                    elements.canvasContainer.classList.toggle('canvas-performance-protected',protectedMode);
                    api.applyCanvasVisualTransform({dispatchTransformEvent:false});
                    const grid=getComputedStyle(elements.canvasGrid),canvas=getComputedStyle(elements.canvasContainer),rect=elements.canvasContainer.getBoundingClientRect(),matrix=path.getScreenCTM();
                    const start=path.getPointAtLength(0).matrixTransform(matrix),end=path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
                    result.push({themeId,zoom,protectedMode,baseSpacing,background,actualBackground:canvas.backgroundImage,cover:canvas.backgroundSize,
                        gridImage:grid.backgroundImage,spacing:grid.backgroundSize,position:grid.backgroundPosition,opacity:grid.opacity,
                        source:center(source),target:center(target),start:{x:start.x,y:start.y},end:{x:end.x,y:end.y},
                        coordinate:api.screenToCanvas(rect.left+37+100*zoom,rect.top-19+100*zoom)});
                }
            }
            elements.canvasContainer.style.setProperty('--canvas-grid-opacity','.37');
            elements.canvasContainer.style.setProperty('--canvas-dot-spacing','31px');
            api.refreshCanvasThemeMetrics();api.applyCanvasVisualTransform({dispatchTransformEvent:false});
            const custom={opacity:getComputedStyle(elements.canvasGrid).opacity,spacing:getComputedStyle(elements.canvasGrid).backgroundSize};
            window.gridViewportClick=null;elements.canvasContainer.addEventListener('click',event=>window.gridViewportClick=event.target.id,{once:true});
            const rect=elements.canvasContainer.getBoundingClientRect();
            return {samples:result,custom,click:{x:rect.left+15,y:rect.top+15},decorative:{ariaHidden:elements.canvasGrid.getAttribute('aria-hidden'),tabindex:elements.canvasGrid.getAttribute('tabindex'),legacyNodeId:legacyNode.id,distinct:legacyNode!==elements.canvasGrid}};
        })()`);
        assert.equal(samples.samples.length, 42);
        for (const sample of samples.samples) {
            assert.equal(sample.actualBackground, sample.background, `${sample.themeId} retains its background layers`);
            assert.ok(sample.cover.split(',').every(value => value.trim() === 'cover'));
            assert.match(sample.gridImage, /^radial-gradient\(/);
            const spacing = `${sample.baseSpacing * sample.zoom}px`;
            assert.equal(sample.spacing, `${spacing} ${spacing}`);
            assert.equal(sample.position, sample.protectedMode ? '0px 0px' : '37px -19px');
            assert.equal(sample.opacity, '1');
            assert.deepEqual(sample.coordinate, { x: 100, y: 100 });
            for (const [port, endpoint] of [[sample.source, sample.start], [sample.target, sample.end]]) {
                assert.ok(Math.abs(port.x - endpoint.x) < 0.1 && Math.abs(port.y - endpoint.y) < 0.1,
                    `${sample.themeId} at ${sample.zoom}: connection endpoints remain centered on their real ports`);
            }
        }
        assert.deepEqual(samples.custom, { opacity: '0.37', spacing: '46.5px 46.5px' });
        assert.deepEqual(samples.decorative, { ariaHidden: 'true', tabindex: null, legacyNodeId: 'canvas-grid', distinct: true });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...samples.click });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...samples.click });
        assert.equal(await app.evaluate('gridViewportClick'), 'canvas-container');
    });
});

test('one drag stays inside a single wire raster margin', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        canvas: { x: 20, y: -10, zoom: .75 },
        nodes: [{ id: 'margin-source', type: 'Text', x: 80, y: 160 }, { id: 'margin-dest', type: 'Text', x: 680, y: 210 }],
        connections: [{ id: 'margin-edge', from: { nodeId: 'margin-source', port: 'text' },
            to: { nodeId: 'margin-dest', port: 'text' }, type: 'text' }]
    }, async app => {
        await app.waitFor("document.querySelector('[data-conn-id=margin-edge]')?.getAttribute('d')");
        const result = await app.evaluate(`(async () => {
            const canvas = document.getElementById('canvas-container');
            const svg = document.getElementById('connections-svg');
            const mouse = (target, type, x, buttons) => target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, button: 1, buttons, clientX: x, clientY: 560
            }));
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const margin = () => parseFloat(getComputedStyle(svg).getPropertyValue('--pan-margin')) || 0;
            const anchor = () => svg.style.getPropertyValue('--wire-anchor');
            mouse(canvas, 'mousedown', 505, 4);
            mouse(document, 'mousemove', 545, 4);
            await paint();
            const opened = { margin: margin(), anchor: anchor(), width: canvas.clientWidth, height: canvas.clientHeight };
            const anchors = [anchor()];
            // 420px is well past the old fixed 192px margin and still inside one drag.
            for (const x of [605, 705, 845, 925]) {
                mouse(document, 'mousemove', x, 4);
                await paint();
                anchors.push(anchor());
            }
            const released = { anchor: anchor() };
            mouse(document, 'mouseup', 925, 0);
            await paint();
            return { opened, anchors, released };
        })()`);
        const { opened, anchors } = result;
        assert.ok(opened.margin >= Math.max(opened.width, opened.height) * .5,
            `the pan margin must cover a real drag instead of the old 192px: ${JSON.stringify(opened)}`);
        assert.deepEqual([...new Set(anchors)], [opened.anchor],
            'a single drag must reuse one painted wire layer instead of re-anchoring repeatedly');
    });
});

test('the experimental connection bitmap follows zoom and returns to SVG over a focused editor', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        canvas: { x: 0, y: 0, zoom: .85 },
        nodes: [{ id: 'bitmap-source', type: 'Text', x: 80, y: 160 }, { id: 'bitmap-dest', type: 'Text', x: 680, y: 210 }],
        connections: [{ id: 'bitmap-edge', from: { nodeId: 'bitmap-source', port: 'text' },
            to: { nodeId: 'bitmap-dest', port: 'text' }, type: 'text' }]
    }, async app => {
        await app.waitFor("document.querySelector('[data-conn-id=bitmap-edge].canvas-rendered')?.getAttribute('d')");
        await app.evaluate(`
            window.bitmapState = () => {
                const layer = document.querySelector('.canvas-connections');
                const path = document.querySelector('[data-conn-id=bitmap-edge]');
                return { visibility: getComputedStyle(layer).visibility, stroke: getComputedStyle(path).stroke, width: layer.width };
            };
            document.querySelector('#bitmap-source textarea').focus();
            document.getElementById('canvas-container').dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, clientX: 490, clientY: 410, deltaY: -14
            }));
        `);
        await app.waitFor("bitmapState().visibility === 'visible' && bitmapState().stroke === 'none'");
        const active = await app.evaluate('bitmapState()');
        assert.ok(active.width > 300, 'the projected curve uses an allocated bitmap');
        await app.waitFor("bitmapState().visibility === 'hidden' && bitmapState().stroke !== 'none'");
        assert.equal(await app.evaluate("document.activeElement.closest('.node')?.id"), 'bitmap-source');
    }, {
        initScript: "if (location.hostname === '127.0.0.1') history.replaceState(null, '', '?perf=1&canvasConnections=1');"
    });
});
