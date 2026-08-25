import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCanvasStressTestBridge } from '../js/app/dev/canvas-stress-test.js';
import {
    createCanvasPerformanceMonitor,
    MIXED_NODE_BENCHMARK_FIXTURE_OPTIONS
} from '../js/app/dev/canvas-performance-monitor.js';
import { registerGlobalBridges } from '../js/app/register-global-bridges.js';

function createFixtureHarness(search = '?stressTest=1') {
    const addedTypes = [];
    const state = {
        nodes: new Map(),
        connections: [],
        runningNodeIds: new Set(),
        canvas: { x: 0, y: 0, zoom: 1 }
    };
    const documentRef = {
        createElement(tagName) {
            assert.equal(tagName, 'canvas');
            return {
                getContext() {
                    return {
                        createImageData(width, height) {
                            return { data: new Uint8ClampedArray(width * height * 4) };
                        },
                        putImageData() {}
                    };
                },
                toDataURL() { return 'data:image/jpeg;base64,fixture'; }
            };
        }
    };
    const bridge = createCanvasStressTestBridge({
        state,
        addNode(type, _x, _y, data) {
            const id = `fixture-node-${state.nodes.size + 1}`;
            addedTypes.push(type);
            state.nodes.set(id, {
                el: {
                    innerText: data.customTitle,
                    classList: { add() {}, remove() {} },
                    remove() {}
                }
            });
            return id;
        },
        mediaControllerApi: { renderImageImportUploadState() {} },
        updateAllConnections() {},
        scheduleSave() {},
        showToast() {},
        nodesLayer: { appendChild() {} },
        documentRef,
        globalRef: {
            location: { search },
            requestAnimationFrame(callback) { callback(0); return 1; }
        }
    });
    return { bridge, state, addedTypes };
}

test('canvas benchmark tools remain unavailable without explicit development flags', async () => {
    const { bridge, state } = createFixtureHarness('');
    const monitor = createCanvasPerformanceMonitor({
        globalRef: { location: { search: '' } }
    });
    const globalRef = {};

    registerGlobalBridges({
        windowRef: globalRef,
        createCanvasStressTestNodes: bridge.createCanvasStressTestNodes,
        enableCanvasStressTest: bridge.enabled,
        sampleCanvasPerformance: monitor.sample,
        enableCanvasPerformanceMonitor: monitor.enabled
    });

    assert.equal(bridge.enabled, false);
    assert.equal(monitor.enabled, false);
    assert.deepEqual(await bridge.createCanvasStressTestNodes({ total: 5 }), []);
    assert.equal(state.nodes.size, 0);
    assert.equal(globalRef.createCanvasStressTestNodes, undefined);
    assert.equal(globalRef.sampleCanvasPerformance, undefined);
});

test('development flags expose the Mixed-node benchmark fixture contract', async () => {
    const { bridge, state, addedTypes } = createFixtureHarness('?stressTest=1');

    const ids = await bridge.createCanvasStressTestNodes({ ...MIXED_NODE_BENCHMARK_FIXTURE_OPTIONS });

    assert.equal(bridge.enabled, true);
    assert.equal(ids.length, 200);
    assert.equal(addedTypes.filter((type) => type === 'ImageImport').length, 50);
    assert.equal(addedTypes.filter((type) => type === 'Text').length, 150);
    assert.equal(state.connections.length, 400);
    assert.ok(state.connections.every((connection, index) => connection.id === `stress_connection_${index + 1}`));
    assert.ok(state.runningNodeIds.size > 0);
});

test('Performance sampling run reports frame metrics and fixture size', async () => {
    let now = 0;
    const globalRef = {
        location: { search: '?perf=1' },
        performance: { now: () => now },
        requestAnimationFrame(callback) {
            now += 10;
            callback(now);
            return now;
        },
        document: null
    };
    const monitor = createCanvasPerformanceMonitor({
        globalRef,
        getFixtureSize: () => ({ nodeCount: 200, connectionCount: 400 })
    });

    const result = await monitor.sample(30);

    assert.equal(monitor.enabled, true);
    assert.equal(result.durationMs, 30);
    assert.equal(result.nodeCount, 200);
    assert.equal(result.connectionCount, 400);
    assert.ok(result.fps > 0);
    assert.ok(Number.isFinite(result.p95FrameMs));
    assert.equal(result.longFrameCount, 0);
    assert.deepEqual(result.costs, {
        'render-projection': 0,
        'connection-full-refresh': 0
    });
});

test('Performance sampling run drives the fixed Canvas interaction sequence', async () => {
    let now = 0;
    const interactionSteps = [];
    const monitor = createCanvasPerformanceMonitor({
        globalRef: {
            location: { search: '?perf=1' },
            performance: { now: () => now },
            requestAnimationFrame(callback) {
                now += 10;
                callback(now);
                return now;
            },
            document: null
        },
        performInteractionStep(step) { interactionSteps.push(step); }
    });

    await monitor.sample(40);

    assert.deepEqual(
        interactionSteps.filter(({ phase }) => phase === 'start').map(({ kind }) => kind),
        ['pan', 'zoom', 'node-drag', 'connection-draw']
    );
    assert.deepEqual(interactionSteps.at(-1), {
        kind: 'connection-draw',
        phase: 'finish',
        progress: 1
    });
});

test('Performance sampling run drives attributable projection work on every sampled frame', async () => {
    let now = 0;
    const projectionSteps = [];
    const monitor = createCanvasPerformanceMonitor({
        globalRef: {
            location: { search: '?perf=1' },
            performance: { now: () => now },
            requestAnimationFrame(callback) {
                now += 10;
                callback(now);
                return now;
            },
            document: null
        },
        performProjectionStep(step) {
            projectionSteps.push(step);
            return {
                nodeProjectionCount: 1,
                connectionFullRefreshCount: 1
            };
        }
    });

    const result = await monitor.sample(40);

    assert.deepEqual(projectionSteps, [
        { frame: 1, elapsedMs: 10 },
        { frame: 2, elapsedMs: 20 },
        { frame: 3, elapsedMs: 30 },
        { frame: 4, elapsedMs: 40 }
    ]);
    assert.deepEqual(result.workload, {
        sampledFrameCount: 4,
        nodeProjectionCount: 4,
        connectionFullRefreshCount: 4
    });
});

test('application bootstrap wires benchmark telemetry only through gated dev modules', async () => {
    const source = await readFile(new URL('../js/app/bootstrap-impl.js', import.meta.url), 'utf8');

    assert.match(source, /createCanvasStressTestBridge/);
    assert.match(source, /createCanvasPerformanceMonitor/);
    assert.match(source, /performanceMonitor:\s*canvasPerformanceMonitor/g);
    assert.match(source, /enableCanvasStressTest:\s*canvasStressTestBridge\.enabled/);
    assert.match(source, /enableCanvasPerformanceMonitor:\s*canvasPerformanceMonitor\.enabled/);
    assert.match(source, /canvasBenchmarkMode \? async \(\) => false/);
    assert.match(source, /canvasBenchmarkMode \? async \(\) => true/);
});

test('Mixed-node benchmark fixture keeps media payloads outside the render measurement', () => {
    assert.deepEqual(MIXED_NODE_BENCHMARK_FIXTURE_OPTIONS, {
        total: 200,
        imageImportCount: 50,
        imageSize: 1,
        connectionCount: 400,
        isolate: true,
        ephemeral: true
    });
});
