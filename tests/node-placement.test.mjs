import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeBounds, findNearbyNodePosition, findAgentImageNodePosition } from '../js/features/execution/node-placement.js';

test('Agent image generation stays near the visible origin when other nodes occupy distant rows', () => {
    const position = findAgentImageNodePosition({ centerX: 500, y: 100, width: 410, occupiedNodes: [
        { x: 300, y: 2000, width: 410, height: 340 },
        { x: 800, y: -2000, width: 410, height: 340 }
    ] });
    assert.deepEqual(position, { x: 295, y: 100 });
    const nearby = findAgentImageNodePosition({ centerX: 500, y: 100, width: 410, occupiedNodes: [
        { x: 295, y: 100, width: 410, height: 340 }
    ] });
    assert.ok(Math.hypot(nearby.x - 295, nearby.y - 100) <= 500);
    assert.ok(nearby.x >= 745 || nearby.y >= 480 || nearby.y + 340 <= 100);
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
