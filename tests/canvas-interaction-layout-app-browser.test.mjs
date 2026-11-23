import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const movementCount = 20;
const targetIds = Array.from({ length: 5 }, (_, index) => `layout-target-${index}`);
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
    nodes: [
        { id: 'layout-source', type: 'Text', x: 70, y: 260, text: '拖动源节点' },
        ...targetIds.map((id, index) => ({ id, type: 'Text', x: 620, y: 50 + index * 120 }))
    ],
    connections: targetIds.map(id => ({
        id: `edge-${id}`,
        from: { nodeId: 'layout-source', port: 'text' },
        to: { nodeId: id, port: 'text' },
        type: 'text'
    }))
};

function layoutCount(metrics) {
    const value = metrics.metrics.find(metric => metric.name === 'LayoutCount')?.value;
    assert.ok(Number.isFinite(value), 'Chromium exposes its layout counter');
    return value;
}

test('creating an image generation node avoids repeated synchronous card measurements', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const resourcePaths = [];
        app.onProtocolEvent(event => {
            if (event.method === 'Network.requestWillBeSent') resourcePaths.push(new URL(event.params.request.url).pathname);
        });
        const reads = await app.evaluate(`(() => {
            let count = 0;
            const descriptors = ['offsetWidth', 'offsetHeight'].map(key =>
                [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]);
            try {
                for (const [key, descriptor] of descriptors) {
                    Object.defineProperty(HTMLElement.prototype, key, { ...descriptor, get() {
                        if (this.matches('.node-generate')) count++;
                        return descriptor.get.call(this);
                    } });
                }
                document.querySelector('.context-menu-item[data-type="ImageGenerate"]').click();
            } finally {
                for (const [key, descriptor] of descriptors) Object.defineProperty(HTMLElement.prototype, key, descriptor);
            }
            return count;
        })()`);
        assert.ok(reads <= 2, `the new card was synchronously measured ${reads} times during creation`);
        await app.waitFor(`(() => {
            const node = document.querySelector('.node-generate.selected');
            return node?.offsetHeight >= 300 && document.querySelector('#image-parameter-panel')?.checkVisibility();
        })()`);
        const id = await app.evaluate(`(async () => {
            const { registry } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const id = document.querySelector('.node-generate').id;
            await registry.nodeLifecycleApi.waitForImageRestores([id]);
            return id;
        })()`);
        assert.ok(!resourcePaths.includes('/api/storage/assets/' + id), 'a newly allocated node has no historical asset to restore');
        await app.evaluate(`(() => {
            const canvas = document.getElementById('canvas-container');
            canvas.focus();
            canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
        })()`);
        await app.waitFor("!document.querySelector('.node-generate') && !!document.getElementById('layout-source')");
    });
});

test('startup network results stay out of an active drag and appear after release', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            window.noticeDragState = state;
            const header = state.nodes.get('layout-source').el.querySelector('.node-header');
            const rect = header.getBoundingClientRect();
            window.noticeDragPoint = { x: rect.left + 28, y: rect.top + 16 };
            header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true,
                button: 0, buttons: 1, clientX: noticeDragPoint.x, clientY: noticeDragPoint.y }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
                buttons: 1, clientX: noticeDragPoint.x + 30, clientY: noticeDragPoint.y + 20 }));
        })()`);
        assert.equal(await app.evaluate("noticeDragState.dragging?.nodes.includes('layout-source')"), true);

        // Resolve the actual startup connectivity request and all three proxy
        // probes while the pointer is held. No real external network is used.
        for (let index = 0; index < 4; index++) {
            await app.waitFor(`window.pendingNetworkProbes.length > ${index}`);
            await app.evaluate(`pendingNetworkProbes[${index}]()`);
        }
        await app.waitFor(`import('/js/services/storage-documents.js').then(({ diskStorage }) =>
            JSON.parse(diskStorage.getItem('cainflow_network_proxy_detection') || 'null')?.result?.shouldNotify === true)`);
        await app.evaluate('new Promise(resolve => setTimeout(resolve, 150))');
        const networkUi = `({ notice: !!document.querySelector('.network-proxy-notice:not(.hidden)'),
            toasts: [...document.querySelectorAll('.toast-message')].filter(el => /网络连接|网络环境/.test(el.textContent)).length })`;
        assert.deepEqual(await app.evaluate(networkUi), { notice: false, toasts: 0 },
            'completed background checks must not insert layout work during the held drag');

        await app.evaluate(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true,
            button: 0, clientX: noticeDragPoint.x + 30, clientY: noticeDragPoint.y + 20 }))`);
        await app.waitFor(`!noticeDragState.dragging && (${networkUi}).notice && (${networkUi}).toasts === 2`);
        assert.deepEqual(await app.evaluate(networkUi), { notice: true, toasts: 2 },
            'release publishes both completed results without losing the network warning');
    }, { initScript: `(() => {
        const originalFetch = window.fetch.bind(window);
        window.pendingNetworkProbes = [];
        window.fetch = (input, options) => {
            if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname !== '/api/probe_network_target') {
                return originalFetch(input, options);
            }
            return new Promise(resolve => pendingNetworkProbes.push(() => resolve(new Response(JSON.stringify({
                success: true, status: 204, latency: 12, detail: 'Controlled network probe'
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
        };
    })();` });
});

test('a small canvas batches drag layout while keeping all wires aligned and the move undoable', { timeout: 30000 }, async t => {
    await withAppBrowser(session, async app => {
        await app.waitFor(`(${JSON.stringify(targetIds)}).every(id =>
            Boolean(document.querySelector('path[data-conn-id="edge-' + id + '"]')?.getAttribute('d')))`);
        await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const source = state.nodes.get('layout-source');
            const original = { x: source.x, y: source.y };
            const header = source.el.querySelector('.node-header');
            const rect = header.getBoundingClientRect();
            const start = { x: rect.left + 28, y: rect.top + rect.height / 2 };
            const pointer = (type, dx = 0, dy = 0) => (type === 'mousedown' ? header : document).dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
                    buttons: type === 'mouseup' ? 0 : 1, clientX: start.x + dx, clientY: start.y + dy }));
            const aligned = () => (${JSON.stringify(targetIds)}).every(id => {
                const path = document.querySelector('path[data-conn-id="edge-' + id + '"]');
                const output = document.querySelector('#layout-source .node-port[data-direction="output"][data-port="text"] .port-dot');
                const input = document.querySelector('#' + id + ' .node-port[data-direction="input"][data-port="text"] .port-dot');
                if (!path?.getAttribute('d') || !output || !input) return false;
                const matrix = path.getScreenCTM();
                const from = path.getPointAtLength(0).matrixTransform(matrix);
                const to = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
                const a = output.getBoundingClientRect(), b = input.getBoundingClientRect();
                return Math.hypot(from.x - a.left - a.width / 2, from.y - a.top - a.height / 2) < 2 &&
                    Math.hypot(to.x - b.left - b.width / 2, to.y - b.top - b.height / 2) < 2;
            });
            window.layoutDrag = { state, frames, original, pointer, aligned };
            pointer('mousedown');
            pointer('mousemove', 8, 4);
            // Exclude selection, first geometry measurements and observer setup.
            await frames();
            await frames();
        })()`);
        assert.equal(await app.evaluate("layoutDrag.state.dragging?.nodes.includes('layout-source')"), true);

        await app.send('Performance.enable');
        const before = layoutCount(await app.send('Performance.getMetrics'));
        await app.evaluate(`(async () => {
            for (let index = 1; index <= ${movementCount}; index++) {
                layoutDrag.pointer('mousemove', 8 + index * 4, 4 + index * 2);
                await layoutDrag.frames();
            }
        })()`);
        const layouts = layoutCount(await app.send('Performance.getMetrics')) - before;
        t.diagnostic(`${movementCount} drag movements, 5 outgoing wires: ${layouts} layouts`);
        // One forced measurement and one normal browser layout per movement,
        // plus a small allowance for unrelated work at the interval boundary.
        assert.ok(layouts <= movementCount * 2 + 4,
            `drag layout must be bounded by frames rather than outgoing wires; observed ${layouts}`);

        assert.equal(await app.evaluate('layoutDrag.aligned()'), true, 'all five wires follow the held node');
        const moved = await app.evaluate(`(() => {
            const { state, original } = layoutDrag, node = state.nodes.get('layout-source');
            return { x: (node.x - original.x) * state.canvas.zoom, y: (node.y - original.y) * state.canvas.zoom };
        })()`);
        assert.deepEqual(moved, { x: 88, y: 44 }, 'the measured interval actually moves the authoritative node');

        await app.evaluate("layoutDrag.pointer('mouseup', 88, 44); layoutDrag.frames()");
        await app.waitFor('layoutDrag.state.dragging === null && layoutDrag.aligned()');
        assert.deepEqual(await app.evaluate(`(() => {
            const node = layoutDrag.state.nodes.get('layout-source');
            return { left: parseFloat(node.el.style.left), top: parseFloat(node.el.style.top), x: node.x, y: node.y };
        })()`), { left: 158, top: 304, x: 158, y: 304 }, 'release commits the same node position');

        await app.evaluate(`(() => {
            const canvas = document.getElementById('canvas-container');
            canvas.focus();
            canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
        })()`);
        await app.waitFor(`(() => {
            const { state, original } = layoutDrag, node = state.nodes.get('layout-source');
            return node.x === original.x && node.y === original.y && layoutDrag.aligned();
        })()`);
        assert.equal(await app.evaluate('layoutDrag.state.connections.length'), 5, 'one undo retains all wires');
    });
});

test('pan and zoom keep interaction styling local while focused text retains native wheel scrolling', { timeout: 30000 }, async () => {
    const text = Array.from({ length: 100 }, (_, index) => `Scrollable line ${index + 1}`).join('\n');
    await withAppBrowser({
        ...session,
        themeId: 'glass-dark',
        nodes: [
            { id: 'scope-text', type: 'Text', x: 80, y: 80, width: 260, height: 190, userResized: true, text },
            // The video node exercises the theme's glass surface.
            { id: 'scope-glass', type: 'VideoGenerate', x: 540, y: 100 }
        ],
        connections: []
    }, async app => {
        await app.evaluate(`(async () => {
            const { state, registry } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            registry.themeControllerApi.applyTheme('glass-dark');
            const canvas = document.getElementById('canvas-container');
            const editor = document.getElementById('scope-text-text');
            const glass = document.querySelector('#scope-glass .node-glass-bg');
            const styles = () => {
                const control = getComputedStyle(editor);
                return { cursor: control.cursor, userSelect: control.userSelect,
                    glass: getComputedStyle(glass).backdropFilter,
                    bodyInteraction: document.body.classList.contains('is-interacting'),
                    pan: canvas.classList.contains('is-panning'), zoom: canvas.classList.contains('is-zooming') };
            };
            window.interactionScope = { state, canvas, editor, styles };
        })()`);
        assert.equal(await app.evaluate('document.documentElement.dataset.appTheme'), 'glass-dark');
        const idle = await app.evaluate('interactionScope.styles()');
        assert.match(idle.glass, /blur\(/, 'the chosen node has a real glass backdrop before interaction');
        assert.equal(idle.cursor, 'grab');
        assert.equal(idle.userSelect, 'text');
        assert.equal(idle.bodyInteraction, false);

        const pan = await app.evaluate(`(() => {
            const { canvas, editor, styles } = interactionScope;
            const rect = canvas.getBoundingClientRect();
            const x = rect.left + 400, y = rect.top + 400;
            interactionScope.panPoint = { x, y };
            canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true,
                button: 1, buttons: 4, clientX: x, clientY: y }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 4,
                clientX: x + 40, clientY: y + 20 }));
            const editorRect = editor.getBoundingClientRect();
            const hit = document.elementFromPoint(editorRect.left + 12, editorRect.top + 12);
            const surface = getComputedStyle(canvas, '::after');
            return { ...styles(), hitCanvas: hit === canvas, cursor: surface.cursor, userSelect: surface.userSelect };
        })()`);
        assert.deepEqual(pan, { hitCanvas: true, cursor: 'grabbing', userSelect: 'none', glass: 'none', bodyInteraction: false, pan: true, zoom: false });

        await app.evaluate(`(() => {
            const { x, y } = interactionScope.panPoint;
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, buttons: 0,
                clientX: x + 40, clientY: y + 20 }));
        })()`);
        await app.waitFor('!interactionScope.state.canvas.isPanning && !interactionScope.styles().pan');
        assert.deepEqual(await app.evaluate('interactionScope.styles()'), idle, 'releasing pan restores editable control and glass styles');

        const zoom = await app.evaluate(`(() => {
            const { canvas, state, styles } = interactionScope;
            const before = state.canvas.zoom, rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
                clientX: rect.left + 450, clientY: rect.top + 300, deltaY: -80 }));
            return { before, after: state.canvas.zoom, styles: styles() };
        })()`);
        assert.ok(zoom.after > zoom.before, 'the wheel really zooms the canvas');
        assert.equal(zoom.styles.zoom, true);
        assert.equal(zoom.styles.bodyInteraction, false);
        assert.equal(zoom.styles.glass, 'none', 'local zoom feedback disables the glass backdrop');
        await app.waitFor('!interactionScope.styles().zoom');
        assert.equal(await app.evaluate('interactionScope.styles().glass'), idle.glass, 'settling zoom restores the backdrop');
        assert.equal(await app.evaluate('interactionScope.styles().bodyInteraction'), false);

        const scroll = await app.evaluate(`(() => {
            const { editor, state } = interactionScope;
            editor.focus(); editor.scrollTop = 0;
            const rect = editor.getBoundingClientRect();
            return { x: rect.left + 40, y: rect.top + 40,
                zoom: state.canvas.zoom, scrollable: editor.scrollHeight > editor.clientHeight + 1 };
        })()`);
        assert.equal(scroll.scrollable, true, 'the native wheel target has overflowing text');
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scroll.x, y: scroll.y });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroll.x, y: scroll.y, deltaX: 0, deltaY: 120 });
        await app.waitFor('interactionScope.editor.scrollTop > 0');
        assert.equal(await app.evaluate('interactionScope.state.canvas.zoom'), scroll.zoom, 'scrolling the focused editor does not zoom the canvas');
        assert.equal(await app.evaluate('interactionScope.styles().zoom'), false);
    });
});

test('touch drags a canvas node header, settles interrupted capture, and leaves mouse dragging available', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const node = state.nodes.get('layout-source');
            const header = node.el.querySelector('.node-header');
            window.headerDrag = {
                state, node, mousePresses: 0,
                point: () => {
                    const rect = header.querySelector('.node-title').getBoundingClientRect();
                    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                },
                position: () => [node.x, node.y],
                idle: () => !state.dragging && !node.el.classList.contains('is-interacting')
                    && !document.getElementById('connections-group').classList.contains('is-interacting')
            };
            header.addEventListener('mousedown', () => headerDrag.mousePresses++);
        })()`);
        await app.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
        const offset = (point, x, y) => ({ x: point.x + x, y: point.y + y });
        const touch = (type, point) => app.send('Input.dispatchTouchEvent', {
            type, touchPoints: point ? [{ ...point, id: 1 }] : []
        });
        const captured = 'headerDrag.state.dragging?.captureTarget?.hasPointerCapture(headerDrag.state.dragging.pointerId)';
        const start = await app.evaluate('headerDrag.point()');
        assert.equal(await app.evaluate(`document.elementFromPoint(${start.x},${start.y})?.closest('.node')?.id`), 'layout-source');
        const original = await app.evaluate('headerDrag.position()');
        const end = offset(start, 60, 40);
        await touch('touchStart', start);
        await app.waitFor(captured);
        await touch('touchMove', end);
        await app.waitFor(`headerDrag.node.x === ${original[0] + 60} && headerDrag.node.y === ${original[1] + 40}`);
        await touch('touchEnd');
        await app.waitFor('headerDrag.idle()');
        assert.deepEqual(await app.evaluate('headerDrag.position()'), [original[0] + 60, original[1] + 40]);
        assert.equal(await app.evaluate('headerDrag.mousePresses'), 0, 'touch did not start a compatibility mouse drag');

        const nextStart = await app.evaluate('headerDrag.point()');
        const nextEnd = offset(nextStart, 26, 20);
        await touch('touchStart', nextStart);
        await app.waitFor(captured);
        await touch('touchMove', nextEnd);
        await app.waitFor('headerDrag.node.el.classList.contains("is-interacting")');
        await touch('touchCancel');
        await app.waitFor('headerDrag.idle()');

        const lostStart = await app.evaluate('headerDrag.point()');
        await touch('touchStart', lostStart);
        await app.waitFor(captured);
        await touch('touchMove', offset(lostStart, 24, 16));
        await app.waitFor('headerDrag.node.el.classList.contains("is-interacting")');
        await app.evaluate('(() => { const { captureTarget, pointerId } = headerDrag.state.dragging; captureTarget.releasePointerCapture(pointerId); })()');
        await touch('touchMove', offset(lostStart, 30, 16));
        await app.waitFor('headerDrag.idle()');
        await touch('touchEnd');

        const bypass = await app.evaluate(`(() => {
            const rect = headerDrag.node.el.querySelector('.node-bypass-btn').getBoundingClientRect();
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
        await touch('touchStart', bypass);
        await touch('touchEnd');
        await app.waitFor('headerDrag.node.el.classList.contains("disabled")');
        assert.equal(await app.evaluate('headerDrag.idle()'), true, 'a header button remains a tap target');

        await app.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        const mouseStart = await app.evaluate('headerDrag.point()');
        const mouseEnd = offset(mouseStart, 36, 24);
        const beforeMouse = await app.evaluate('headerDrag.position()');
        const beforeMousePresses = await app.evaluate('headerDrag.mousePresses');
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...mouseStart });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...mouseEnd });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...mouseEnd });
        await app.waitFor('headerDrag.idle()');
        assert.deepEqual(await app.evaluate('headerDrag.position()'), [beforeMouse[0] + 36, beforeMouse[1] + 24]);
        assert.equal(await app.evaluate('headerDrag.mousePresses'), beforeMousePresses + 1);
    });
});
