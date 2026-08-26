import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bindMouseNodeRunCancelHold } from '../js/nodes/node-run-cancel-hold.js';

class FakeTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }
}

function createHarness({ reducedMotion = false } = {}) {
    let clock = 0;
    let nextTimerId = 1;
    let nextFrameId = 1;
    const timers = new Map();
    const frames = new Map();
    const classes = new Set();
    const styles = new Map();
    const view = new FakeTarget();
    const media = { matches: reducedMotion };
    view.matchMedia = () => media;
    const documentRef = new FakeTarget();
    documentRef.defaultView = view;
    documentRef.visibilityState = 'visible';
    const button = new FakeTarget();
    button.style = { setProperty(name, value) { styles.set(name, value); } };
    button.classList = {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); }
    };
    button.setPointerCapture = () => {};
    button.hasPointerCapture = () => false;
    const cancellations = [];
    const toasts = [];

    const cleanup = bindMouseNodeRunCancelHold({
        button,
        nodeId: 'node-a',
        isNodeRunning: () => true,
        cancelRunningNode: (nodeId) => { cancellations.push(nodeId); return true; },
        showToast: (...args) => toasts.push(args),
        documentRef,
        now: () => clock,
        setTimeoutRef(callback) { const id = nextTimerId++; timers.set(id, callback); return id; },
        clearTimeoutRef(id) { timers.delete(id); },
        requestAnimationFrameRef(callback) { const id = nextFrameId++; frames.set(id, callback); return id; },
        cancelAnimationFrameRef(id) { frames.delete(id); }
    });

    const pointer = (overrides = {}) => ({
        pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, clientY: 10,
        preventDefault() {}, stopPropagation() {}, ...overrides
    });
    const down = (overrides) => button.dispatch('pointerdown', pointer(overrides));
    const runFrame = () => {
        const entry = frames.entries().next().value;
        assert.ok(entry, 'expected a queued progress frame');
        frames.delete(entry[0]);
        entry[1]();
    };
    const fireTimer = () => {
        const entry = timers.entries().next().value;
        assert.ok(entry, 'expected an active hold timer');
        timers.delete(entry[0]);
        entry[1]();
    };

    return {
        button, view, documentRef, media, classes, styles, timers, frames, cancellations, toasts,
        cleanup, pointer, down, runFrame, fireTimer,
        setClock(value) { clock = value; }
    };
}

test('node cancellation accepts only a held primary mouse button', () => {
    const harness = createHarness();
    for (const event of [
        { pointerType: 'touch', button: 0 },
        { pointerType: 'pen', button: 0 },
        { pointerType: 'mouse', button: 1 },
        { pointerType: 'mouse', button: 2 }
    ]) {
        harness.down(event);
        assert.equal(harness.timers.size, 0);
    }

    harness.down();
    assert.equal(harness.timers.size, 1);
    harness.down({ pointerId: 2 });
    assert.equal(harness.timers.size, 1, 'a second input must not start another hold session');
    harness.fireTimer();
    assert.deepEqual(harness.cancellations, ['node-a']);
});

test('progress uses one elapsed-time source across reduced-motion mode changes', () => {
    const harness = createHarness();
    harness.down();
    harness.setClock(1000);
    harness.runFrame();
    assert.equal(harness.styles.get('--node-cancel-progress'), '0.5');

    harness.media.matches = true;
    harness.setClock(1250);
    harness.runFrame();
    assert.equal(harness.styles.get('--node-cancel-progress'), '0.5');
    harness.setClock(1500);
    harness.runFrame();
    assert.equal(harness.styles.get('--node-cancel-progress'), '0.75');
    assert.equal(harness.timers.size, 1, 'changing display mode must not restart the hold timer');
});

test('release, drag threshold, window blur, and page hiding abort a hold', () => {
    const scenarios = [
        (h) => h.button.dispatch('pointerup', h.pointer()),
        (h) => h.button.dispatch('pointercancel', h.pointer()),
        (h) => h.button.dispatch('pointermove', h.pointer({ clientX: 19 })),
        (h) => h.view.dispatch('blur'),
        (h) => { h.documentRef.visibilityState = 'hidden'; h.documentRef.dispatch('visibilitychange'); }
    ];
    for (const abort of scenarios) {
        const harness = createHarness();
        harness.down();
        abort(harness);
        assert.equal(harness.timers.size, 0);
        assert.equal(harness.frames.size, 0);
        assert.equal(harness.classes.has('is-holding'), false);
        assert.equal(harness.styles.get('--node-cancel-progress'), '0');
        assert.deepEqual(harness.cancellations, []);
    }
});

test('decorative animation disabling explicitly exempts functional animation elements', async () => {
    const [foundation, nodeView, settings] = await Promise.all([
        readFile(new URL('../css/modules/00-foundation.css', import.meta.url), 'utf8'),
        readFile(new URL('../js/nodes/node-view-factory.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/features/settings/general-settings.js', import.meta.url), 'utf8')
    ]);
    assert.match(foundation, /:not\(\.functional-animation\)/);
    assert.match(nodeView, /node-run-cancel-btn__progress-fill functional-animation/);
    assert.match(nodeView, /tabindex="-1" title="鼠标左键长按 2 秒取消此节点运行"/);
    assert.match(settings, /装饰动画/);
    assert.match(settings, /功能性动画仍会保留/);
});
