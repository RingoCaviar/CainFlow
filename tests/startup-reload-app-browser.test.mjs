import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { withAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'source', type: 'ImageImport', x: 40, y: 160, width: 300, height: 300, userResized: true },
        { id: 'preview', type: 'ImagePreview', x: 550, y: 160, width: 300, height: 300, userResized: true }
    ],
    connections: [{ id: 'retained-reference', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image', extension: { retained: true } }]
};

const graph = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>({nodes:document.value.nodes,connections:document.value.connections}))");

test('the real application serves a burst of assets and reloads without losing stylesheets or the saved graph', { timeout: 90000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor('window.__cainflowAppReady===true');
        await waitForAutosave(app);
        const original = await graph(app);
        const assets = await Promise.all(Array.from({ length: 128 }, () => new Promise(resolve => {
            get(`${app.server.baseUrl}/css/modules/04-node-core.css`, { agent: false }, response => {
                let bytes = 0;
                response.on('data', chunk => { bytes += chunk.length; });
                response.on('end', () => resolve({ status: response.statusCode, bytes }));
                response.on('error', error => resolve({ error: error.code }));
            }).on('error', error => resolve({ error: error.code }));
        })));
        const failures = assets.filter(asset => asset.status !== 200 || !asset.bytes);
        assert.deepEqual(failures, [], `a real burst must serve all 128 local stylesheet requests; ${failures.length} failed`);
        for (let iteration = 0; iteration < 3; iteration++) {
            const previous = await app.evaluate('performance.timeOrigin');
            await app.send('Page.reload', { ignoreCache: true });
            // Each navigation gets one attempt. A refused stylesheet or script
            // request must fail this regression instead of being hidden by retry.
            await app.waitFor(`performance.timeOrigin!==${previous} && window.__cainflowAppReady===true && document.querySelectorAll('#nodes-layer > .node').length===2`);
            const surfaces = await app.evaluate("[...document.querySelectorAll('#nodes-layer>.node')].map(node=>({id:node.id,position:getComputedStyle(node).position,left:node.style.left,top:node.style.top,dots:[...node.querySelectorAll('.node-port:not([hidden]) .port-dot')].filter(dot=>dot.getClientRects().length).map(dot=>{const rect=dot.getBoundingClientRect();return {width:rect.width,height:rect.height}})}))");
            assert.ok(surfaces.every(node => node.position === 'absolute'), `reload ${iteration + 1} applies the real node positioning stylesheet: ${JSON.stringify(surfaces)}`);
            assert.ok(surfaces.every(node => node.dots.length >= 1 && node.dots.every(dot => dot.width > 0 && dot.height > 0)), `reload ${iteration + 1} restores measurable input and output anchors: ${JSON.stringify(surfaces)}`);
            assert.deepEqual(await graph(app), original, `reload ${iteration + 1} leaves the saved graph intact`);
        }
    });
});

test('restoring a populated canvas shows loading instead of empty creation guidance', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await waitForAutosave(app);
        const reloadLoadingPage = async () => {
            let unsubscribe;
            const loaded = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { unsubscribe?.(); reject(new Error('Reload did not finish loading its document')); }, 7500);
                unsubscribe = app.onProtocolEvent(event => {
                    if (event.method !== 'Page.loadEventFired') return;
                    clearTimeout(timer); unsubscribe(); resolve();
                });
            });
            await app.send('Page.reload', { ignoreCache: true });
            await loaded;
            await app.waitFor('typeof window.releaseCanvasRestore === "function"');
        };
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch=window.fetch;window.fetch=async(url,options)=>{
            if(String(url).includes('/api/storage/documents/session')) await new Promise(resolve=>window.releaseCanvasRestore=resolve);
            return originalFetch(url,options);
        };` });
        await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await reloadLoadingPage();
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state').hidden"), true);
        assert.equal(await app.evaluate("Boolean(document.getElementById('canvas-loading-state') && !document.getElementById('canvas-loading-state').hidden)"), true);
        const motion = await app.evaluate(`(() => {
            const indicator=document.querySelector('[data-canvas-load-progress] .canvas-loading-indicator');
            if (!indicator) return null;
            const animation=indicator.getAnimations()[0];
            return { css:getComputedStyle(indicator).animationName, display:getComputedStyle(indicator).display, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches, classes:document.documentElement.className, running:animation?.playState, properties:Object.keys(animation?.effect.getKeyframes()[0] || {}) };
        })()`);
        assert.ok(motion, 'loading feedback has a compositor-friendly indicator');
        assert.equal(motion.running, 'running', JSON.stringify(motion));
        assert.ok(motion.properties.includes('transform'));
        assert.ok(!motion.properties.includes('width') && !motion.properties.includes('left'));
        let layers = [];
        const unsubscribe = app.onProtocolEvent(event => {
            if (event.method === 'LayerTree.layerTreeDidChange') layers = event.params.layers || [];
        });
        await app.send('LayerTree.enable');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const document = await app.send('DOM.getDocument');
        const node = await app.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.canvas-loading-indicator' });
        const details = await app.send('DOM.describeNode', { nodeId: node.nodeId });
        const layer = layers.find(item => item.backendNodeId === details.node.backendNodeId);
        assert.ok(layer, 'the moving indicator has its own composited layer');
        const reasons = await app.send('LayerTree.compositingReasons', { layerId: layer.layerId });
        assert.match(reasons.compositingReasons.join(' '), /transform/i);
        unsubscribe();
        await app.send('LayerTree.disable');
        await app.evaluate("document.documentElement.classList.add('animations-disabled')");
        assert.equal(await app.evaluate("document.querySelector('.canvas-loading-indicator').getAnimations()[0]?.playState"), 'running', 'functional feedback survives disabling decoration');
        await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('.canvas-loading-indicator')).animationName"), 'canvas-loading-gentle');
        const reducedMotion = await app.evaluate(`(async()=>{
            const indicator=document.querySelector('.canvas-loading-indicator');
            const animation=indicator.getAnimations()[0];
            if (!animation) return null;
            const before=animation.currentTime;
            const transform=getComputedStyle(indicator).transform;
            for(let frame=0;frame<6;frame++) await new Promise(requestAnimationFrame);
            return { running:animation.playState, elapsed:animation.currentTime-before,
                moved:getComputedStyle(indicator).transform!==transform };
        })()`);
        assert.ok(reducedMotion && reducedMotion.running === 'running' && reducedMotion.elapsed > 0 && reducedMotion.moved,
            'reduced motion must retain visible loading feedback');
        await reloadLoadingPage();
        await app.waitFor("document.querySelector('.canvas-loading-indicator').getAnimations()[0]?.playState==='running'");
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('.canvas-loading-indicator')).animationName"), 'canvas-loading-gentle',
            'refreshing with reduced motion must still animate');
        await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        if (process.env.CAINFLOW_LOADING_VISUALS) {
            await mkdir(process.env.CAINFLOW_LOADING_VISUALS, { recursive: true });
            for (const theme of ['paper', 'dark']) {
                await app.evaluate(`document.documentElement.dataset.appTheme='${theme}'`);
                const screenshot = await app.send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_LOADING_VISUALS, `${theme}.png`), Buffer.from(screenshot.data, 'base64'));
            }
        }
        await app.evaluate('window.releaseCanvasRestore()');
        await app.waitFor("window.__cainflowAppReady===true && document.querySelectorAll('#nodes-layer>.node').length===2");
        assert.equal(await app.evaluate("document.getElementById('canvas-loading-state').hidden"), true);
        assert.equal(await app.evaluate("document.querySelector('.canvas-loading-indicator').getAnimations().length"), 0, 'completed loading releases its animation');
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state').hidden"), true);
    });
});

test('opening a saved workflow keeps loading visible until its content is ready', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        const target = { workflowId: 'loading-target', nodes: [{ id: 'loaded-target', type: 'Text', text: 'saved content', x: 100, y: 100 }], connections: [] };
        await app.evaluate(`fetch('/api/workflows/LoadingTarget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(target)})})`);
        await app.evaluate(`const originalOpenFetch=window.fetch;window.fetch=async(url,options)=>{
            if(String(url).includes('/api/workflows/LoadingTarget') && (!options?.method || options.method==='GET')) await new Promise(resolve=>window.releaseWorkflowLoad=resolve);
            return originalOpenFetch(url,options);
        };import('/js/app/bootstrap.js').then(module=>module.bootstrapCainFlowApp()).then(app=>{window.openLoadingWorkflow=app.workflowManagerApi.openWorkflow('LoadingTarget');});`);
        await app.waitFor('typeof window.releaseWorkflowLoad === "function"');
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state').hidden"), true);
        assert.equal(await app.evaluate("document.getElementById('canvas-loading-state').hidden"), false);
        await app.evaluate('window.releaseWorkflowLoad()');
        await app.waitFor("Boolean(document.getElementById('loaded-target')) && document.getElementById('canvas-loading-state').hidden");
        assert.equal(await app.evaluate('window.openLoadingWorkflow'), true);
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state').hidden"), true);
    });
});

test('loading 100 image nodes batches restore scheduling without dropping nodes', { timeout: 60000 }, async () => {
    const fixture = { autoCheckUpdatesOnLoad: false, nodes: Array.from({ length: 100 }, (_, index) => ({
        id: `load-${index}`, type: 'ImageImport', x: index % 10 * 340, y: Math.floor(index / 10) * 380
    })), connections: [] };
    await withAppBrowser(fixture, async app => {
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 100);
        const frames = await app.evaluate('window.restoreSchedulingFrames || 0');
        assert.ok(frames > 0 && frames < 100, `100 restores should share frame budgets instead of scheduling ${frames} frames`);
    }, { initScript: `window.restoreSchedulingFrames=0;const append=Node.prototype.appendChild;
        Node.prototype.appendChild=function(child){const result=append.call(this,child);
            if(child.tagName==='IFRAME'&&child.contentWindow){const frame=child.contentWindow;const raf=frame.requestAnimationFrame.bind(frame);
                frame.requestAnimationFrame=callback=>{if(callback.name==='runNextImageRestoreTask')window.restoreSchedulingFrames++;return raf(callback);};}
            return result;};` });
});
