import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('the public viewport preserves identical DOM while real transforms, theme metrics and projection intents still update', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [],
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }] }, async app => {
        await app.evaluate(`(async()=>{
            const {createViewportApi}=await import('/js/canvas/viewport.js');
            const canvasContainer=document.createElement('div'),nodesLayer=document.createElement('div'),zoomLevel=document.createElement('span');
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),connectionsGroup=document.createElementNS(svg.namespaceURI,'g'),originAxes=document.createElementNS(svg.namespaceURI,'g');
            canvasContainer.style.setProperty('--canvas-dot-spacing','31px');
            svg.append(connectionsGroup,originAxes);canvasContainer.append(nodesLayer,svg,zoomLevel);document.body.append(canvasContainer);
            const state={canvas:{x:23,y:-17,zoom:1}},intents=[],events=[];
            document.addEventListener('cainflow:canvas-transform',event=>events.push(event.detail));
            const api=createViewportApi({state,elements:{canvasContainer,nodesLayer,connectionsGroup,originAxes,zoomLevel},scheduleConnectionRefresh:options=>intents.push(options),updateAllConnections(){throw new Error('scheduled projection is the configured public intent path')}});
            const observer=new MutationObserver(()=>{});observer.observe(canvasContainer,{attributes:true,childList:true,characterData:true,subtree:true,attributeOldValue:true});
            const snapshot=()=>({nodeTransform:nodesLayer.style.transform,origin:nodesLayer.style.transformOrigin,zoom:nodesLayer.style.getPropertyValue('--canvas-zoom'),connections:connectionsGroup.getAttribute('transform'),axes:originAxes.getAttribute('transform'),spacing:canvasContainer.style.getPropertyValue('--canvas-dot-spacing-scaled'),offsetX:canvasContainer.style.getPropertyValue('--canvas-dot-offset-x'),offsetY:canvasContainer.style.getPropertyValue('--canvas-dot-offset-y'),label:zoomLevel.textContent});
            window.viewportBudget={api,state,intents,events,observer,canvasContainer,nodesLayer,zoomLevel,snapshot};
            api.updateCanvasTransform();observer.takeRecords();
            viewportBudget.originalLabel=zoomLevel.firstChild;
        })()`);
        assert.deepEqual(await app.evaluate('(()=>{viewportBudget.api.updateCanvasTransform();return viewportBudget.observer.takeRecords().map(record=>[record.type,record.attributeName])})()'), [], 'repeating the same transform must not write any style, SVG attribute or text');
        assert.deepEqual(await app.evaluate('viewportBudget.snapshot()'), {
            nodeTransform: 'translate(23px, -17px) scale(1)', origin: '0px 0px', zoom: '1',
            connections: 'translate(23, -17) scale(1)', axes: 'translate(23, -17) scale(1)',
            spacing: '31px', offsetX: '23px', offsetY: '-17px', label: '100%'
        });
        assert.deepEqual(await app.evaluate('({events:viewportBudget.events,intents:viewportBudget.intents.length})'), {
            events: [{ x: 23, y: -17, zoom: 1 }, { x: 23, y: -17, zoom: 1 }], intents: 2
        }, 'unchanged presentation must not suppress the event or connection projection contract');

        await app.evaluate('viewportBudget.state.canvas.x=91;viewportBudget.state.canvas.y=42;viewportBudget.api.updateCanvasTransform({forceConnections:true,immediateConnections:true,settleConnections:true,connectionRefreshReason:"public-pan"})');
        assert.equal(await app.evaluate('viewportBudget.zoomLevel.firstChild===viewportBudget.originalLabel'), true, 'panning preserves the original zoom label text node');
        assert.deepEqual(await app.evaluate('viewportBudget.snapshot()'), {
            nodeTransform: 'translate(91px, 42px) scale(1)', origin: '0px 0px', zoom: '1',
            connections: 'translate(91, 42) scale(1)', axes: 'translate(91, 42) scale(1)',
            spacing: '31px', offsetX: '91px', offsetY: '42px', label: '100%'
        });
        assert.deepEqual(await app.evaluate('viewportBudget.intents.at(-1)'), { force: true, immediate: true, settle: true, reason: 'public-pan' });

        await app.evaluate('viewportBudget.state.canvas.zoom=.5;viewportBudget.api.updateCanvasTransform()');
        assert.deepEqual(await app.evaluate('viewportBudget.snapshot()'), {
            nodeTransform: 'translate(91px, 42px) scale(0.5)', origin: '0px 0px', zoom: '0.5',
            connections: 'translate(91, 42) scale(0.5)', axes: 'translate(91, 42) scale(0.5)',
            spacing: '15.5px', offsetX: '91px', offsetY: '42px', label: '50%'
        });
        assert.deepEqual(await app.evaluate('viewportBudget.events.at(-1)'), { x: 91, y: 42, zoom: .5 });

        const beforeTheme = await app.evaluate('({events:viewportBudget.events.length,intents:viewportBudget.intents.length})');
        await app.evaluate('viewportBudget.canvasContainer.style.setProperty("--canvas-dot-spacing","40px");viewportBudget.api.refreshCanvasThemeMetrics();viewportBudget.api.updateCanvasTransform({dispatchTransformEvent:false,updateConnections:false})');
        assert.equal(await app.evaluate('viewportBudget.snapshot().spacing'), '20px', 'a changed theme metric refreshes the real grid spacing at the current zoom');
        assert.deepEqual(await app.evaluate('({events:viewportBudget.events.length,intents:viewportBudget.intents.length})'), beforeTheme, 'the existing explicit event and projection opt-outs remain intact');
    });
});
