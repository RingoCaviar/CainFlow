import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('active zoom feedback stays synchronous across themes and matches the unregistered CSS fallback', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, globalAnimationEnabled: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
        nodes: [{ id: 'source', type: 'Text', x: 100, y: 100, width: 240, text: 'source' },
            { id: 'target', type: 'Text', x: 500, y: 100, width: 240, text: 'target' }],
        connections: [{ id: 'edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' }]
    }, async app => {
        const result = await app.evaluate(`(async()=>{
            const {createViewportApi}=await import('/js/canvas/viewport.js');
            const {createElements}=await import('/js/core/elements.js');
            const {createThemeControllerApi}=await import('/js/features/ui/theme-controller.js');
            const elements=createElements(document),state={canvas:{x:37,y:-19,zoom:1}};
            const api=createViewportApi({state,elements,updateAllConnections(){}});
            const theme=createThemeControllerApi({state:{},onThemeApplied:()=>api.refreshCanvasThemeMetrics()});
            const node=document.getElementById('source'),glass=node.querySelector('.node-glass-bg'),body=node.querySelector('.node-body');
            const states={normal:[],selected:['selected'],batch:['batch-connection-source'],selectedBatch:['selected','batch-connection-source'],insert:['connection-insert-candidate'],armed:['connection-shake-armed'],detached:['connection-shake-detached']};
            const classes=[...new Set(Object.values(states).flat())];
            const properties=['content','position','top','right','bottom','left','width','height','padding-top','padding-right','padding-bottom','padding-left','border-top-width','border-right-width','border-bottom-width','border-left-width','border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius','border-top-color','border-top-style','box-shadow','background-image','background-color','color','font-size','font-weight','line-height','white-space','transform','z-index','pointer-events','backdrop-filter'];
            const choose=(el,pseudo=null)=>{const css=getComputedStyle(el,pseudo);return Object.fromEntries(properties.map(property=>[property,css.getPropertyValue(property)]))};
            const zoomAt=(el,pseudo=null)=>getComputedStyle(el,pseudo).getPropertyValue('--canvas-zoom').trim();
            const center=el=>{const rect=el.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}};
            const path=document.querySelector('[data-conn-id=edge]');
            const collect=()=>{
                const samples=[];
                for(const themeId of ['dark','pro','paper','light','glass-light','glass-dark','pink']){
                    theme.applyTheme(themeId);
                    for(const zoom of [.1,.5,1,1.5,5]){
                        state.canvas.zoom=zoom;api.applyCanvasVisualTransform({dispatchTransformEvent:false});
                        for(const [name,active] of Object.entries(states)){
                            node.classList.remove(...classes);if(active.length)node.classList.add(...active);
                            // Class activation must acquire current zoom without another viewport call or frame.
                            const scope={root:zoomAt(node),before:zoomAt(node,'::before'),after:zoomAt(node,'::after'),glass:zoomAt(glass),body:zoomAt(body)};
                            const matrix=path.getScreenCTM(),start=path.getPointAtLength(0).matrixTransform(matrix),end=path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
                            samples.push({themeId,zoom,name,scope,root:choose(node),before:choose(node,'::before'),after:choose(node,'::after'),glass:choose(glass),
                                source:center(node.querySelector('.node-port[data-direction=output] .port-dot')),target:center(document.querySelector('#target .node-port[data-direction=input] .port-dot')),
                                start:{x:start.x,y:start.y},end:{x:end.x,y:end.y},path:path.getAttribute('d'),transform:elements.nodesLayer.style.transform});
                        }
                    }
                }
                return samples;
            };
            const registered=collect();
            // Ignoring @property in older engines leaves this same stylesheet's ordinary inheritance.
            // Removing only that rule exercises the fallback while retaining every original skin rule.
            const removeRegistration=sheet=>{
                let removed=0;
                for(let index=sheet.cssRules.length-1;index>=0;index--){const rule=sheet.cssRules[index];
                    if(rule.styleSheet)removed+=removeRegistration(rule.styleSheet);
                    if(rule.constructor.name==='CSSPropertyRule'&&rule.name==='--canvas-zoom'){sheet.deleteRule(index);removed++;}
                }
                return removed;
            };
            const removed=[...document.styleSheets].reduce((count,sheet)=>count+removeRegistration(sheet),0);
            return {registered,fallback:collect(),removed};
        })()`);

        assert.equal(result.removed, 1, 'the shared skin registers zoom once');
        assert.equal(result.registered.length, 245);
        assert.equal(result.fallback.length, 245);
        for (let index = 0; index < result.registered.length; index++) {
            const current = result.registered[index], fallback = result.fallback[index];
            const { scope, ...visual } = current, { scope: fallbackScope, ...fallbackVisual } = fallback;
            const context = `${current.themeId}/${current.zoom}/${current.name}`;
            assert.deepEqual(visual, fallbackVisual, `${context}: every ring, label, glass and port value matches the working fallback`);
            const zoom = String(current.zoom), batch = ['batch', 'selectedBatch'].includes(current.name);
            assert.equal(scope.root, current.name === 'normal' ? '1' : zoom, `${context}: immediate node feedback`);
            assert.equal(scope.before, batch ? zoom : '1');
            assert.equal(scope.after, batch ? zoom : '1');
            assert.equal(scope.glass, ['batch', 'selectedBatch', 'insert', 'armed', 'detached'].includes(current.name) ? zoom : '1');
            assert.equal(scope.body, '1', `${context}: controls do not inherit changing zoom`);
            assert.ok(Object.values(fallbackScope).every(value => value === zoom), `${context}: unregistered browsers retain normal inheritance`);
            if (current.name === 'selected') assert.notEqual(current.root['box-shadow'], 'none');
            if (batch) {
                assert.equal(current.after.content, '"批量连线源节点"');
                assert.ok(Math.abs(parseFloat(current.after['font-size']) * current.zoom - 12) < .001);
                assert.ok(Math.abs(parseFloat(current.after.height) - 26 / current.zoom) < 1 / 64);
            }
            for (const [port, endpoint] of [[current.source, current.start], [current.target, current.end]]) {
                assert.ok(Math.abs(port.x - endpoint.x) < .1 && Math.abs(port.y - endpoint.y) < .1,
                    `${context}: feedback preserves real connection-port alignment`);
            }
        }
    });
});
