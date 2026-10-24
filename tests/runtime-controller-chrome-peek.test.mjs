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
    const classes = new Set();
    const classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    };
    const handlers = new Map();
    const toolbar = { offsetHeight: 64, getBoundingClientRect: () => ({ top: -64, bottom: 0 }) };
    const canvasContainer = { classList, contains: () => false };
    const documentRef = {
        body: { classList }, activeElement: null, defaultView: {},
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
        state: { selectedNodes: new Set(), isMouseOverCanvas: true }, canvasContainer,
        contextMenu: { classList }, selectionApi: { selectAllNodes: noop },
        runWorkflow: noop, saveState: noop, showToast: noop, exportWorkflow: noop,
        undo: () => history.push('undo'), redo: () => history.push('redo'),
        copySelectedNode: noop, pasteNode: noop,
        clipboardControllerApi: { markNativeClipboardEvent: noop }, removeNode: noop,
        zoomToFit: noop, scheduleSave: noop, closeModal: noop, documentRef, windowRef
    }).initRuntimeBindings();
    return { classes, documentRef, history, handlers };
}

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
