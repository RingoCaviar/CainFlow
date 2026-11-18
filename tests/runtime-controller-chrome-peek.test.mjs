import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeControllerApi, hasOpenImmersivePreview } from '../js/features/ui/runtime-controller.js';
import { applyCanvasUiSetting } from '../js/features/ui/canvas-ui-controller.js';

test('a hidden fullscreen preview does not suppress toolbar peek', () => {
    const hiddenOverlay = {
        classList: { contains: (className) => className === 'hidden' }
    };
    const documentRef = {
        querySelector: (selector) => selector === '.fullscreen-overlay' ? hiddenOverlay : null
    };

    assert.equal(hasOpenImmersivePreview(documentRef), false);
});

test('an active fullscreen preview suppresses toolbar peek', () => {
    const documentRef = {
        querySelector: (selector) => selector === '.fullscreen-overlay.active' ? {} : null
    };

    assert.equal(hasOpenImmersivePreview(documentRef), true);
});

function makeRuntime() {
    const state = { selectedNodes: new Set(), isMouseOverCanvas: true };
    const classes = new Set();
    const classWrites = [];
    const classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, enabled) => { classWrites.push(name); return enabled ? classes.add(name) : classes.delete(name); }
    };
    const handlers = new Map();
    const activity = { hover: false, focus: false, controls: false };
    const toolbar = { offsetHeight: 64, getBoundingClientRect: () => ({ top: -64, bottom: 0 }),
        matches: selector => selector === ':hover' && activity.hover,
        querySelector: selector => (selector === ':focus-visible' ? activity.focus : activity.controls) ? {} : null,
        addEventListener: (name, handler) => handlers.set(`toolbar:${name}`, handler) };
    const canvasContainer = { classList, contains: () => false };
    const documentRef = {
        body: { classList }, activeElement: null, defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }), MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(target) { if (target === toolbar) handlers.set('toolbar:mutation', this.callback); }
        } },
        documentElement: { style: { setProperty() {} } },
        getElementById: id => id === 'toolbar' ? toolbar : null,
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: (name, handler) => handlers.set(`document:${name}`, handler)
    };
    const windowRef = {
        location: { search: '' },
        addEventListener: (name, handler) => handlers.set(`window:${name}`, handler),
        getComputedStyle: () => ({ getPropertyValue: () => '100px' }),
        getSelection: () => ({ toString: () => '' })
    };
    const noop = () => {};
    const history = [];
    createRuntimeControllerApi({
        state, canvasContainer,
        contextMenu: { classList }, selectionApi: { selectAllNodes: noop },
        runWorkflow: noop, saveState: noop, showToast: noop, exportWorkflow: noop,
        undo: () => history.push('undo'), redo: () => history.push('redo'),
        copySelectedNode: noop, pasteNode: noop,
        clipboardControllerApi: { markNativeClipboardEvent: noop }, removeNode: noop,
        zoomToFit: noop, scheduleSave: noop, closeModal: noop, documentRef, windowRef
    }).initRuntimeBindings();
    return { state, classes, documentRef, history, handlers, activity, classWrites };
}

test('toolbar activity tracks local hover, keyboard focus and control state without repeated body writes', () => {
    const { classes, handlers, activity, classWrites } = makeRuntime();
    assert.equal(classes.has('toolbar-controls-active'), false);
    activity.hover = true;
    handlers.get('toolbar:pointerenter')();
    assert.equal(classes.has('toolbar-controls-active'), true);
    activity.focus = true;
    activity.hover = false;
    handlers.get('toolbar:pointerleave')();
    assert.equal(classes.has('toolbar-controls-active'), true, 'keyboard focus keeps chrome clear');
    activity.focus = false;
    activity.controls = true;
    handlers.get('toolbar:focusout')();
    assert.equal(classes.has('toolbar-controls-active'), true, 'expanded controls keep chrome clear');
    activity.controls = false;
    handlers.get('toolbar:mutation')();
    assert.equal(classes.has('toolbar-controls-active'), false);
    const writes = classWrites.length;
    handlers.get('toolbar:mutation')();
    handlers.get('toolbar:focusout')();
    assert.equal(classWrites.length, writes, 'unrelated unchanged toolbar updates must not invalidate the body');
    activity.focus = true;
    handlers.get('toolbar:keydown')();
    assert.equal(classes.has('toolbar-controls-active'), true, 'keyboard modality does not require moving focus');
});

test('the unified toolbar still peeks and dismisses without a sidebar', () => {
    const { classes, handlers } = makeRuntime();
    const pointermove = handlers.get('window:pointermove');
    assert.equal(typeof pointermove, 'function');
    pointermove({ clientX: 500, clientY: 20 });
    assert.equal(classes.has('toolbar-peek-active'), true);
    pointermove({ clientX: 0, clientY: 300 });
    assert.equal(classes.has('toolbar-peek-active'), false);
    assert.equal(classes.has('sidebar-peek-active'), false);
    pointermove({ clientX: 500, clientY: 20 });
    handlers.get('window:blur')();
    assert.equal(classes.has('toolbar-peek-active'), false);
});

test('canvas undo and both redo shortcuts remain available without toolbar history buttons', () => {
    const { documentRef, handlers, history } = makeRuntime();
    const keydown = handlers.get('document:keydown');
    const event = { ctrlKey: true, target: documentRef.body, preventDefault() {} };
    keydown({ ...event, key: 'z' });
    keydown({ ...event, key: 'y' });
    keydown({ ...event, key: 'Z', shiftKey: true });
    keydown({ ...event, key: 'z', ctrlKey: false, metaKey: true });
    keydown({ ...event, key: 'z', target: { nodeType: 1, closest: () => ({}) } });
    assert.deepEqual(history, ['undo', 'redo', 'redo', 'undo']);
});

test('canvas toolbar visibility clears obsolete left-toolbar presentation', () => {
    const { classes, documentRef } = makeRuntime();
    classes.add('sidebar-pinned');
    classes.add('sidebar-peek-active');
    assert.deepEqual(applyCanvasUiSetting({ state: { toolbarPinned: true, sidebarPinned: true }, documentRef }), { toolbarPinned: true });
    assert.equal(classes.has('toolbar-pinned'), true);
    assert.equal(classes.has('sidebar-pinned'), false);
    assert.equal(classes.has('sidebar-peek-active'), false);
});


test('canvas gestures suspend hover-peek geometry and resume on release without another move', async () => {
    const { state, classes, documentRef, handlers } = makeRuntime();
    const move = handlers.get('window:pointermove');
    move({ clientX: 100, clientY: 20 });
    assert.equal(classes.has('toolbar-peek-active'), true);
    const original = documentRef.querySelector;
    let queries = 0;
    documentRef.querySelector = (...args) => { queries++; return original(...args); };
    for (const key of ['dragging', 'resizing', 'connecting', 'marquee', 'isCutting']) {
        state[key] = {};
        move({ clientX: 100, clientY: 20 });
        assert.equal(classes.has('toolbar-peek-active'), false);
        state[key] = null;
    }
    state.canvas = { isPanning: true };
    move({ clientX: 100, clientY: 20 });
    assert.equal(queries, 0, 'held canvas gestures do not scan immersive overlays or read chrome geometry');
    state.canvas.isPanning = false;
    handlers.get('window:mouseup')({ clientX: 100, clientY: 20 });
    await Promise.resolve();
    assert.equal(classes.has('toolbar-peek-active'), true);
    assert.ok(queries > 0);
    state.dragging = {};
    move({ clientX: 100, clientY: 20 });
    state.dragging = null;
    handlers.get('window:mouseup')({ clientX: 100, clientY: 20 });
    handlers.get('window:blur')();
    await Promise.resolve();
    assert.equal(classes.has('toolbar-peek-active'), false, 'blur cancels a pending release restoration');
    state.connecting = {};
    move({ clientX: 100, clientY: 20 });
    state.connecting = null;
    handlers.get('window:keydown')({ key: 'Escape' });
    await Promise.resolve();
    assert.equal(classes.has('toolbar-peek-active'), true, 'keyboard cancellation restores peek at the last pointer without another move');
});
