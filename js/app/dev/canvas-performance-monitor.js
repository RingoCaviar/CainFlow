/** Development-only frame sampler for repeatable canvas profiling. */
export function createCanvasPerformanceMonitor({
    globalRef = globalThis,
    getFixtureSize = () => ({ nodeCount: 0, connectionCount: 0 })
} = {}) {
    const enabled = new URLSearchParams(globalRef.location?.search || '').get('perf') === '1';
    const costs = new Map();
    const samples = new Map();

    function measure(name, callback) {
        if (!enabled) return callback();
        const startedAt = globalRef.performance?.now?.() ?? Date.now();
        const result = callback();
        const elapsed = (globalRef.performance?.now?.() ?? Date.now()) - startedAt;
        costs.set(name, (costs.get(name) || 0) + elapsed);
        return result;
    }

    function recordSample(name, value) {
        if (!enabled || !Number.isFinite(value) || value < 0) return;
        const values = samples.get(name) || [];
        values.push(value);
        samples.set(name, values);
    }

    function summarizeSamples() {
        return Object.fromEntries(Array.from(samples, ([name, values]) => {
            const sorted = values.slice().sort((a, b) => a - b);
            const total = sorted.reduce((sum, value) => sum + value, 0);
            return [name, {
                count: sorted.length,
                averageMs: total / sorted.length,
                p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
                maxMs: sorted.at(-1)
            }];
        }));
    }

    function sample(durationMs = 10_000) {
        if (!enabled) return Promise.resolve({ enabled: false });
        costs.clear();
        samples.clear();
        const frames = [];
        const startedAt = globalRef.performance?.now?.() ?? Date.now();
        let previous = startedAt;
        return new Promise((resolve) => {
            const tick = (now) => {
                frames.push(now - previous);
                previous = now;
                if (now - startedAt < durationMs) {
                    globalRef.requestAnimationFrame(tick);
                    return;
                }
                const sorted = frames.slice(1).sort((a, b) => a - b);
                const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
                const total = sorted.reduce((sum, frame) => sum + frame, 0);
                const fixtureSize = getFixtureSize();
                const result = {
                    enabled: true,
                    durationMs: now - startedAt,
                    fps: total > 0 ? sorted.length * 1000 / total : 0,
                    p95FrameMs: p95,
                    longFrameCount: sorted.filter((frame) => frame > 50).length,
                    nodeCount: fixtureSize.nodeCount,
                    connectionCount: fixtureSize.connectionCount,
                    costs: Object.fromEntries(costs),
                    interactionMetrics: summarizeSamples()
                };
                const panel = globalRef.document?.getElementById('cainflow-perf-panel') || globalRef.document?.createElement('pre');
                if (panel && !panel.isConnected) {
                    panel.id = 'cainflow-perf-panel';
                    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;margin:0;padding:10px;background:#111d;color:#d7ffe2;font:12px/1.45 monospace;pointer-events:none;';
                    globalRef.document.body.appendChild(panel);
                }
                if (panel) panel.textContent = `Canvas sample\n${result.nodeCount} nodes | ${result.connectionCount} connections\n${result.fps.toFixed(1)} FPS | p95 ${result.p95FrameMs.toFixed(2)} ms\nlong frames: ${result.longFrameCount}\n${Object.entries(result.costs).map(([name, ms]) => `${name}: ${ms.toFixed(1)} ms`).join('\n')}\n${Object.entries(result.interactionMetrics).map(([name, metric]) => `${name}: p95 ${metric.p95Ms.toFixed(2)} ms, max ${metric.maxMs.toFixed(2)} ms`).join('\n')}`;
                console.table(result.costs);
                console.table(result.interactionMetrics);
                console.info('CainFlow canvas performance sample', result);
                resolve(result);
            };
            globalRef.requestAnimationFrame(tick);
        });
    }

    function mount({ createFixture, clearFixture } = {}) {
        if (!enabled || !globalRef.document || globalRef.document.getElementById('cainflow-perf-controls')) return;
        const controls = globalRef.document.createElement('div');
        controls.id = 'cainflow-perf-controls';
        controls.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;display:flex;gap:6px;padding:8px;background:#111d;color:#d7ffe2;font:12px monospace;';
        const fixtureButton = globalRef.document.createElement('button');
        fixtureButton.textContent = 'Build 200/400 fixture';
        fixtureButton.addEventListener('click', async () => {
            fixtureButton.disabled = true;
            try {
                await createFixture?.({
                    total: 200,
                    imageImportCount: 50,
                    imageSize: 1,
                    connectionCount: 400,
                    isolate: true,
                    ephemeral: true
                });
            } finally {
                fixtureButton.disabled = false;
            }
        });
        const sampleButton = globalRef.document.createElement('button');
        sampleButton.textContent = 'Start 10s sample';
        sampleButton.addEventListener('click', () => { void sample(); });
        const clearButton = globalRef.document.createElement('button');
        clearButton.textContent = 'Clear fixture';
        clearButton.addEventListener('click', () => { clearFixture?.(); });
        controls.append(fixtureButton, sampleButton, clearButton);
        globalRef.document.body.appendChild(controls);
    }

    return { enabled, measure, recordSample, sample, mount };
}
