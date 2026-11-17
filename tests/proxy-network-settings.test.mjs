import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyNetworkSettings } from '../js/features/settings/proxy-network-settings.js';

function createHarness() {
    const timers = new Map(), presentations = [], values = new Map(), responses = [];
    let timerId = 0, requests = 0;
    const state = { canvas: { isPanning: false }, proxy: { enabled: false } };
    const networkProxyStatusState = { checking: false, result: null };
    const constants = {
        networkProxyNoticeId: 'network-proxy-mismatch',
        networkProxyDetectionStorageKey: 'network-cache', networkProxyDetectionCacheVersion: 1,
        networkProxyDetectionTargetsSignature: 'fixture', networkProxyDetectionCooldownMs: 600000,
        NETWORK_PROBE_TARGETS: [{ name: 'probe', url: 'https://probe.test/' }],
        NETWORK_CONNECTIVITY_TARGETS: [{ name: 'connectivity', url: 'https://connectivity.test/' }]
    };
    const api = createProxyNetworkSettings({
        ctx: {
            state, showToast: (...args) => presentations.push({ kind: 'toast', args }), saveState() {},
            floatingNoticesApi: {
                upsertNotice: notice => presentations.push({ kind: 'notice', notice }),
                hideNotice: id => presentations.push({ kind: 'hide', id })
            },
            documentRef: {},
            windowRef: {
                AbortController,
                setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
                clearTimeout(id) { timers.delete(id); }
            },
            localStorageRef: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
            async fetchImpl() {
                requests++;
                const result = await (responses.length ? responses.shift() : { success: true, latency: 1 });
                return { ok: true, json: async () => result };
            }
        },
        store: { constants, networkProxyStatusState },
        dialogs: {}
    });
    const tick = () => {
        const pending = [...timers].filter(([, timer]) => timer.delay === 100);
        for (const [id, timer] of pending) { timers.delete(id); timer.callback(); }
        return pending.length;
    };
    return { api, state, timers, presentations, values, responses, networkProxyStatusState,
        tick, requests: () => requests, pending: () => [...timers.values()].filter(timer => timer.delay === 100).length };
}

test('startup results finish and cache during each canvas interaction without changing notification DOM', async () => {
    for (const [name, start, stop] of [
        ['drag', state => { state.dragging = {}; }, state => { state.dragging = null; }],
        ['pan', state => { state.canvas.isPanning = true; }, state => { state.canvas.isPanning = false; }],
        ['zoom', state => { state.isInteracting = true; }, state => { state.isInteracting = false; }],
        ['resize', state => { state.resizing = {}; }, state => { state.resizing = null; }],
        ['connection', state => { state.connecting = {}; }, state => { state.connecting = null; }],
        ['marquee', state => { state.marquee = {}; }, state => { state.marquee = null; }]
    ]) {
        const h = createHarness();
        start(h.state);
        const connectivity = await h.api.checkNetworkConnectivity({ deferWhileInteracting: true });
        const proxy = await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
        assert.equal(connectivity.online, true, name);
        assert.equal(proxy.shouldNotify, true, name);
        assert.equal(h.networkProxyStatusState.result, proxy, name);
        assert.equal(h.networkProxyStatusState.checking, false, name);
        assert.equal(JSON.parse(h.values.get('network-cache')).result.shouldNotify, true, name);
        assert.deepEqual(h.presentations, [], `${name}: no toast insertion, notice insertion or removal during interaction`);
        assert.equal(h.pending(), 1, `${name}: one pending timer serves both results`);
        h.tick();
        assert.deepEqual(h.presentations, [], `${name}: timer must recheck active interaction`);
        assert.equal(h.pending(), 1, name);
        stop(h.state);
        h.tick();
        assert.deepEqual(h.presentations.map(item => item.kind), ['toast', 'notice', 'toast'], name);
        assert.equal(h.timers.size, 0, `${name}: no timer survives completed presentation`);
        assert.equal(h.tick(), 0, name);
    }
});

test('manual checks stay immediate during interaction and revoke queued startup results', async () => {
    const h = createHarness();
    h.state.dragging = {};
    await h.api.checkNetworkConnectivity({ deferWhileInteracting: true });
    await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    h.responses.push({ success: false }, { success: false });
    assert.equal((await h.api.checkNetworkConnectivity()).online, false);
    assert.equal((await h.api.checkNetworkProxyMismatch(true)).shouldNotify, false);
    assert.deepEqual(h.presentations.map(item => item.kind), ['toast', 'hide', 'toast']);
    assert.match(h.presentations[0].args[0], /网络连接不可用/);
    assert.equal(h.pending(), 0);
    h.state.dragging = null;
    h.tick();
    assert.equal(h.presentations.length, 3, 'old startup success must never reappear');
});

test('repeated automatic results coalesce by check type and cached results honor interaction deferral', async () => {
    const h = createHarness();
    h.state.dragging = {};
    await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    const cached = await h.api.checkNetworkProxyMismatch(false, { deferWhileInteracting: true });
    assert.equal(cached.shouldNotify, true);
    assert.equal(h.requests(), 1, 'cached request does not repeat detection');
    assert.deepEqual(h.presentations, []);
    h.responses.push({ success: false });
    await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    assert.equal(h.pending(), 1);
    h.state.dragging = null;
    h.tick();
    assert.deepEqual(h.presentations.map(item => item.kind), ['hide', 'toast']);
    assert.match(h.presentations[1].args[0], /未检测到代理/);
});

test('manual connectivity supersedes an older automatic request that finishes later', async () => {
    const h = createHarness();
    h.state.dragging = {};
    let release;
    h.responses.push(new Promise(resolve => { release = resolve; }));
    const automatic = h.api.checkNetworkConnectivity({ deferWhileInteracting: true });
    h.responses.push({ success: false });
    await h.api.checkNetworkConnectivity();
    release({ success: true });
    assert.equal((await automatic).online, true, 'detection result remains available to its own caller');
    h.state.dragging = null;
    h.tick();
    assert.equal(h.presentations.length, 1, 'late startup success must not overwrite manual failure');
    assert.match(h.presentations[0].args[0], /网络连接不可用/);
    assert.equal(h.timers.size, 0);
});

test('automatic connectivity cannot replace pending manual feedback regardless of completion order', async () => {
    for (const manualFirst of [true, false]) {
        const h = createHarness();
        h.state.dragging = {};
        let releaseManual, releaseAutomatic;
        h.responses.push(new Promise(resolve => { releaseManual = resolve; }));
        const manual = h.api.checkNetworkConnectivity();
        h.responses.push(new Promise(resolve => { releaseAutomatic = resolve; }));
        const automatic = h.api.checkNetworkConnectivity({ deferWhileInteracting: true });
        if (!manualFirst) {
            releaseAutomatic({ success: true });
            await automatic;
        }
        releaseManual({ success: false });
        assert.equal((await manual).online, false);
        assert.equal(h.presentations.length, 1, 'manual failure is visible before the drag ends');
        assert.match(h.presentations[0].args[0], /网络连接不可用/);
        if (manualFirst) {
            releaseAutomatic({ success: true });
            await automatic;
        }
        h.state.dragging = null;
        h.tick();
        assert.equal(h.presentations.length, 1, 'the overlapping automatic success cannot replace manual feedback');
        assert.equal(h.timers.size, 0);
    }
});

test('a manual request joining automatic proxy detection presents the shared result immediately', async () => {
    const h = createHarness();
    h.state.dragging = {};
    let release;
    h.responses.push(new Promise(resolve => { release = resolve; }));
    const automatic = h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    const manual = h.api.checkNetworkProxyMismatch(true);
    assert.equal(h.requests(), 1, 'manual intent reuses the in-flight backend probe');
    release({ success: true });
    const [autoResult, manualResult] = await Promise.all([automatic, manual]);
    assert.deepEqual(manualResult, autoResult, 'joined callers receive the current detection result');
    assert.deepEqual(h.presentations.map(item => item.kind), ['notice', 'toast']);
    assert.equal(h.timers.size, 0);
});

test('automatic checks without interactions render immediately and silent checks do not allocate presentation timers', async () => {
    const h = createHarness();
    await h.api.checkNetworkConnectivity({ deferWhileInteracting: true });
    await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    assert.deepEqual(h.presentations.map(item => item.kind), ['toast', 'notice', 'toast']);
    assert.equal(h.timers.size, 0);
    h.state.dragging = {};
    await h.api.checkNetworkConnectivity({ showResultToast: false, deferWhileInteracting: true });
    assert.equal(h.presentations.length, 3);
    assert.equal(h.timers.size, 0);
});

test('enabling the application proxy supersedes a deferred mismatch reminder', async () => {
    const h = createHarness();
    h.state.dragging = {};
    await h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    h.state.proxy.enabled = true;
    const skipped = await h.api.checkNetworkProxyMismatch(true);
    assert.equal(skipped.skippedBecauseProxyEnabled, true);
    assert.deepEqual(h.presentations.map(item => item.kind), ['hide', 'toast']);
    h.state.dragging = null;
    h.tick();
    assert.equal(h.presentations.length, 2);
    assert.equal(h.timers.size, 0);
});

test('a background result arriving after a drag starts waits for release', async () => {
    const h = createHarness();
    let release;
    h.responses.push(new Promise(resolve => { release = resolve; }));
    const checking = h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    h.state.dragging = {};
    release({ success: true });
    assert.equal((await checking).shouldNotify, true);
    assert.deepEqual(h.presentations, []);
    h.tick();
    assert.deepEqual(h.presentations, []);
    h.state.dragging = null;
    h.tick();
    assert.deepEqual(h.presentations.map(item => item.kind), ['notice', 'toast']);
});

test('an automatic caller joining a manual check cannot postpone its requested feedback', async () => {
    const h = createHarness();
    h.state.isInteracting = true;
    let release;
    h.responses.push(new Promise(resolve => { release = resolve; }));
    const manual = h.api.checkNetworkProxyMismatch(true);
    const automatic = h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    release({ success: true });
    assert.deepEqual(await manual, await automatic);
    assert.deepEqual(h.presentations.map(item => item.kind), ['notice', 'toast']);
    assert.equal(h.timers.size, 0);
});

test('changed proxy configuration invalidates queued and in-flight background feedback', async () => {
    const queued = createHarness();
    queued.state.dragging = {};
    await queued.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    queued.state.proxy.enabled = true;
    queued.state.dragging = null;
    queued.tick();
    assert.deepEqual(queued.presentations, [], 'settings changes do not revive a queued mismatch notice');
    assert.equal(queued.timers.size, 0);

    const active = createHarness();
    active.state.dragging = {};
    let release;
    active.responses.push(new Promise(resolve => { release = resolve; }));
    const oldCheck = active.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
    active.state.proxy.enabled = true;
    const current = await active.api.checkNetworkProxyMismatch(true);
    release({ success: true });
    await oldCheck;
    assert.equal(active.networkProxyStatusState.result, current, 'late direct-network detection cannot replace current proxy-enabled status');
    assert.equal(active.values.has('network-cache'), false, 'a detection from an obsolete proxy configuration cannot populate the cache');
    assert.deepEqual(active.presentations.map(item => item.kind), ['hide', 'toast']);
    assert.equal(active.timers.size, 0);
});

test('changing an enabled proxy address invalidates queued and in-flight connectivity feedback', async () => {
    for (const [field, value] of [['ip', '127.0.0.2'], ['port', '8900']]) {
        const queued = createHarness();
        queued.state.proxy = { enabled: true, ip: '127.0.0.1', port: '7890' };
        queued.state.dragging = {};
        await queued.api.checkNetworkConnectivity({ deferWhileInteracting: true });
        queued.state.proxy[field] = value;
        queued.state.dragging = null;
        queued.tick();
        assert.deepEqual(queued.presentations, [], `${field}: a previous proxy result must not reappear after release`);
        assert.equal(queued.timers.size, 0);

        const active = createHarness();
        active.state.proxy = { enabled: true, ip: '127.0.0.1', port: '7890' };
        let release;
        active.responses.push(new Promise(resolve => { release = resolve; }));
        const oldCheck = active.api.checkNetworkConnectivity();
        active.state.proxy[field] = value;
        release({ success: true });
        assert.equal((await oldCheck).online, true, 'the original caller still receives its result');
        assert.deepEqual(active.presentations, [], `${field}: changed proxy settings invalidate an in-flight result`);
        active.responses.push({ success: false });
        await active.api.checkNetworkConnectivity();
        assert.equal(active.presentations.length, 1);
        assert.match(active.presentations[0].args[0], /网络连接不可用/);
    }
});

test('proxy checks for changed settings stay separate and obsolete completions cannot overwrite current results', async () => {
    for (const oldFirst of [true, false]) {
        const h = createHarness();
        h.state.proxy = { enabled: false, ip: '127.0.0.1', port: '7890' };
        let releaseOld, releaseCurrent;
        h.responses.push(new Promise(resolve => { releaseOld = resolve; }));
        const old = h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
        h.state.proxy.port = '8900';
        h.responses.push(new Promise(resolve => { releaseCurrent = resolve; }));
        const current = h.api.checkNetworkProxyMismatch(true);
        assert.equal(h.requests(), 2, 'new proxy settings require a new probe');
        if (oldFirst) {
            releaseOld({ success: true });
            await old;
            assert.equal(h.networkProxyStatusState.checking, true, 'an old completion cannot clear the current checking state');
            assert.equal(h.values.has('network-cache'), false, 'the old configuration cannot populate the cache');
            assert.deepEqual(h.presentations, []);
        }
        const joined = h.api.checkNetworkProxyMismatch(true, { deferWhileInteracting: true });
        assert.equal(h.requests(), 2, 'callers using the current configuration still share its probe');
        releaseCurrent({ success: false });
        const result = await current;
        assert.deepEqual(await joined, result);
        if (!oldFirst) {
            releaseOld({ success: true });
            await old;
        }
        assert.equal(result.shouldNotify, false);
        assert.equal(h.networkProxyStatusState.result, result);
        assert.equal(h.networkProxyStatusState.checking, false);
        assert.equal(JSON.parse(h.values.get('network-cache')).result.shouldNotify, false);
        assert.deepEqual(h.presentations.map(item => item.kind), ['hide', 'toast']);
        assert.equal(h.timers.size, 0);
    }
});
