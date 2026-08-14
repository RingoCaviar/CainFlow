import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasConnectionRenderer } from '../js/canvas/canvas-connection-renderer.js';

function createHarness() {
    const listeners = new Map();
    const operations = [];
    const context = {
        setTransform() {}, clearRect() {}, beginPath() { operations.push('begin'); },
        moveTo() {}, bezierCurveTo() { operations.push('curve'); }, stroke() { operations.push('stroke'); },
        set strokeStyle(value) {}, set lineWidth(value) {}
    };
    const canvas = { className: '', width: 0, height: 0, style: {}, getContext() { return context; } };
    const documentRef = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        createElement() { return canvas; }
    };
    const canvasContainer = {
        prepend() {},
        getBoundingClientRect() { return { width: 100, height: 100 }; }
    };
    let animationFrameCount = 0;
    const windowRef = {
        location: { search: '?canvasConnections=1' }, document: documentRef, devicePixelRatio: 1,
        requestAnimationFrame(callback) { animationFrameCount += 1; callback(); return animationFrameCount; }
    };
    const renderer = createCanvasConnectionRenderer({
        canvasContainer, documentRef, state: { canvas: { x: 0, y: 0, zoom: 1 } }, windowRef
    });
    return { renderer, listeners, operations, get animationFrameCount() { return animationFrameCount; } };
}

test('canvas connection renderer redraws visible static connections during panning', () => {
    const harness = createHarness();
    harness.renderer.draw('visible', {
        start: { x: 0, y: 0 }, control1: { x: 15, y: 0 },
        control2: { x: 35, y: 50 }, end: { x: 50, y: 50 }
    });
    harness.listeners.get('cainflow:canvas-pan-transform')();

    assert.equal(harness.animationFrameCount, 1);
    assert.equal(harness.operations.includes('curve'), true);
    assert.equal(harness.operations.includes('stroke'), true);
});

test('canvas connection renderer skips connections outside the viewport', () => {
    const harness = createHarness();
    harness.renderer.draw('offscreen', {
        start: { x: 200, y: 200 }, control1: { x: 215, y: 200 },
        control2: { x: 235, y: 250 }, end: { x: 250, y: 250 }
    });
    harness.renderer.end();

    assert.equal(harness.operations.includes('stroke'), false);
});
