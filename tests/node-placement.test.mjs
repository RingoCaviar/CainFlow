import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeBounds, findNearbyNodePosition, findViewportNodePosition } from '../js/features/execution/node-placement.js';

test('Agent placement centers a new node in the current viewport with distant rows', () => {
    const viewport = { x: -100, y: -220, width: 1200, height: 980 };
    const position = findViewportNodePosition({ viewport, width: 410, occupied: [
        { x: 300, y: 2000, width: 410, height: 340 },
        { x: 800, y: -2000, width: 410, height: 340 }
    ] });
    assert.deepEqual(position, { x: 295, y: 100 });
});

test('Agent placement prefers an open area on the left when the closer right edge is offscreen', () => {
    const viewport = { x: 0, y: 0, width: 900, height: 550 };
    const position = findViewportNodePosition({ viewport, width: 300, height: 340, occupied: [
        { x: 420, y: 60, width: 180, height: 400 }
    ] });
    assert.deepEqual(position, { x: 80, y: 105 });
});

test('Agent placement avoids the panel when the visible viewport is already occupied', () => {
    const viewport = { x: 0, y: 0, width: 838, height: 820,
        blockedSpan: { x: 850, y: -16, width: 610, height: 852 } };
    const position = findViewportNodePosition({ viewport, occupied: [
        { x: 0, y: 0, width: 832, height: 820 }
    ] });
    assert.deepEqual(position, { x: -340, y: 240 });
});

test('placement ignores distant rows and keeps the preferred right-side anchor at every zoom', () => {
    for (const zoom of [0.25, 0.5, 1, 2]) {
        const source = nodeBounds({ x: -200, y: 100, el: { getBoundingClientRect: () => ({ width: 300 * zoom, height: 340 * zoom }) } }, zoom);
        assert.equal(source.width, 300);
        const occupied = [source, { x: 180, y: -5000, width: 8000, height: 300 }];
        const before = structuredClone(occupied);
        assert.deepEqual(findNearbyNodePosition({ x: source.x + source.width + 80, y: source.y, occupied }), { x: 180, y: 100 });
        assert.deepEqual(occupied, before);
    }
});

test('nearby rectangle search avoids both disabled nodes and existing positioned saves', () => {
    const occupied = [{ x: 380, y: 0, width: 300, height: 5000 }, { x: 380, y: -380, width: 300, height: 340 }];
    const next = findNearbyNodePosition({ x: 380, y: 0, occupied });
    assert.ok(Math.hypot(next.x - 380, next.y) < 800);
    for (const box of occupied) assert.ok(next.x >= box.x + box.width + 40 || next.y >= box.y + box.height + 40 || next.y + 380 <= box.y);
});

test('placement uses rendered node height when stored dimensions are stale', () => {
    const expanded = nodeBounds({
        x: 100,
        y: 100,
        width: 410,
        height: 340,
        el: { offsetWidth: 410, offsetHeight: 720 }
    });
    assert.deepEqual(expanded, { x: 100, y: 100, width: 410, height: 720 });
    const next = findNearbyNodePosition({ x: 100, y: 480, width: 410, occupied: [expanded] });
    assert.ok(next.x >= expanded.x + expanded.width + 40 || next.y >= expanded.y + expanded.height + 40);
});
