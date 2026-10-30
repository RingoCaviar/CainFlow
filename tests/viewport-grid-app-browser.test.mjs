import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('the real canvas grid follows the public viewport across themes without moving ports or intercepting input', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
        nodes: [{ id: 'canvas-grid', type: 'Text', x: 100, y: 100, width: 240, text: 'source' },
            { id: 'target', type: 'Text', x: 500, y: 100, width: 240, text: 'target' }],
        connections: [{ id: 'edge', from: { nodeId: 'canvas-grid', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' }]
    }, async app => {
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
