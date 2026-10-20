import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildIntegrityDrawerModel,
    createDiagnosticExport,
    createMediaIntegrityDrawerController,
    renderMediaIntegrityDrawer
} from '../js/features/media/media-integrity-drawer.js';

const safety = { state: 'gc_suspended', reason: 'missing_media', storageEpoch: 'epoch-secret' };

test('drawer model exposes status, progress, cutoff and ordered missing positions without secrets', () => {
    const model = buildIntegrityDrawerModel({
        safety,
        scan: { complete: false, checkpoint: { phase: 'scan', sourceIndex: 2, sourceCursors: { assets: 4 }, cutoffRevision: 19 } },
        nodes: [{ id: 'node-a', type: 'ImageGenerate', data: {
            label: '出图', imageTaskUrl: 'https://secret.example/path?q=prompt', mediaAssetKeys: ['media:a', 'media:b'],
            mediaIntegrity: { mediaType: 'image', missingItems: [
                { position: 1, assetKey: 'media:very-secret-key', recoverable: true, sourceDomain: 'secret.example' }
            ] }
        }}], workflowId: 'workflow-a', workflowName: '流程 A'
    });
    assert.equal(model.paused, true);
    assert.equal(model.editingBlocked, false);
    assert.equal(model.cutoffRevision, 19);
    assert.equal(model.pendingCount, 1);
    assert.equal(model.recoverableCount, 1);
    assert.equal(model.items[0].positionLabel, '第 2 项');
    assert.equal(model.items[0].sourceDomain, 'secret.example');
    assert.doesNotMatch(JSON.stringify(model), /path\?q|very-secret-key|epoch-secret/);
});

test('diagnostic export uses a strict redacted allowlist', () => {
    const value = createDiagnosticExport({
        safety: { ...safety, credential: 'token' }, report: { reportId: 'r1', cutoffRevision: 8,
            damageItems: [{ damageClass: 'missing_file', identity: 'redacted-id', path: 'C:/secret', url: 'https://secret/x', prompt: 'private' }] }
    });
    assert.deepEqual(value.damageItems[0], { damageClass: 'missing_file', identity: 'redacted-id', stage: '' });
    assert.doesNotMatch(JSON.stringify(value), /token|C:\/secret|https:|private|storageEpoch/);
});

test('an import without a durable remote source requires a local file', () => {
    const model = buildIntegrityDrawerModel({ nodes: [{ id: 'import-a', type: 'ImageImport', data: {
        mediaAssetKeys: ['media:x'], mediaIntegrity: { mediaType: 'image', missingItems: [{ position: 0, assetKey: 'media:x' }] }
    }}] });
    assert.equal(model.items[0].recoverable, false);
});

test('compact drawer omits scan controls and keeps recovery and safety notices visible', () => {
    class Element {
        constructor(tag, ownerDocument) { this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.className = ''; this.textContent = ''; this.listeners = {}; this.classList = { add: (name) => { this.className += ` ${name}`; } }; }
        appendChild(child) { this.children.push(child); return child; }
        replaceChildren() { this.children = []; }
        addEventListener(name, callback) { this.listeners[name] = callback; }
    }
    const documentRef = { createElement: (tag) => new Element(tag, documentRef) };
    const root = new Element('div', documentRef);
    const model = buildIntegrityDrawerModel({ workflowId: 'wf', nodes: [{ id: 'n', type: 'ImageGenerate', data: {
        imageTaskUrl: 'https://safe.example/result', mediaAssetKeys: ['media:a', 'media:b'], mediaIntegrity: { mediaType: 'image', missingItems: [
            { position: 0, assetKey: 'media:a' }, { position: 1, assetKey: 'media:b' }
        ] }
    }}] });
    renderMediaIntegrityDrawer(root, { model, error: '' });
    const all = []; const visit = (node) => { all.push(node); node.children.forEach(visit); }; visit(root);
    const labels = all.map((item) => item.textContent).join('|');
    assert.doesNotMatch(labels, /刷新|暂停扫描|扫描一步|导出脱敏诊断|物理回收正常/);
    assert.equal(all.some((item) => item.className.includes('integrity-status-card')), false);
    assert.match(all.map((item) => item.textContent).join('|'), /第 1 项/);
    assert.match(all.map((item) => item.textContent).join('|'), /第 2 项/);
    assert.ok(all.some((item) => item.textContent === '确认批量恢复'));
    assert.ok(all.some((item) => item.textContent === '确认移除'));
    renderMediaIntegrityDrawer(root, { model: { ...model, state: 'gc_suspended', paused: true }, error: '连接失败' });
    const compactMessages = root.children.map((item) => item.textContent).join('|');
    assert.match(compactMessages, /媒体回收已暂停/);
    assert.match(compactMessages, /连接失败/);
});

test('monitor refreshes backend state and can be stopped with no save lock', async () => {
    let safetyState = 'gc_suspended'; let tick; let cleared = false;
    const controller = createMediaIntegrityDrawerController({
        fetchRef: async (url) => ({ ok: true, json: async () => url.endsWith('safety-status')
            ? { safety: { state: safetyState, reason: safetyState } } : { report: null } }),
        setIntervalRef: (callback) => { tick = callback; return 7; }, clearIntervalRef: (id) => { cleared = id === 7; }
    });
    await controller.startMonitoring();
    safetyState = 'healthy'; await tick(); controller.stopMonitoring();
    assert.equal(controller.getState().model.paused, false);
    assert.equal(controller.getState().model.editingBlocked, false);
    assert.equal(cleared, true);
});

test('monitor coalesces overlapping refreshes while a scan prompt is pending', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let safetyRequests = 0;
    const controller = createMediaIntegrityDrawerController({
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) { safetyRequests += 1; await pending; return { ok: true, json: async () => ({ safety }) }; }
            return { ok: true, json: async () => ({ report: null }) };
        }
    });
    const first = controller.load();
    const second = controller.load();
    release();
    await Promise.all([first, second]);
    assert.equal(safetyRequests, 1);
});

test('stable safety polling only reloads a diagnostic report when its ID changes', async () => {
    let reportId = 'report-a'; let reportRequests = 0; let tick;
    const controller = createMediaIntegrityDrawerController({
        setIntervalRef: (callback) => { tick = callback; return 8; }, clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({ safety: { state: 'healthy', reportId } }) };
            reportRequests += 1;
            return { ok: true, json: async () => ({ report: { reportId } }) };
        }
    });
    await controller.startMonitoring();
    await tick();
    assert.equal(reportRequests, 1);
    reportId = 'report-b';
    await tick();
    assert.equal(reportRequests, 2);
    assert.equal(controller.getState().report.reportId, 'report-b');
    controller.stopMonitoring();
});

test('drawer waits for startup recovery before taking over an unfinished scan', async () => {
    let backgroundScanPending = true; let scans = 0; let tick;
    const controller = createMediaIntegrityDrawerController({
        setIntervalRef: (callback) => { tick = callback; return 12; }, clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({
                safety: { state: 'scanning', backgroundScanPending }
            }) };
            if (url.endsWith('integrity-report')) return { ok: false, status: 404 };
            scans += 1;
            return { ok: true, json: async () => ({ complete: true }) };
        }
    });
    await controller.startMonitoring();
    await tick();
    assert.equal(scans, 0);
    backgroundScanPending = false;
    await tick();
    assert.equal(scans, 1);
    controller.stopMonitoring();
});

test('opening the drawer completes a missing-report scan and stops polling when hidden', async () => {
    let scans = 0;
    let safetyRequests = 0; let reportRequests = 0;
    let safetyState = 'gc_suspended';
    let active = true; let tick; let cleared = false;
    const controller = createMediaIntegrityDrawerController({
        isActive: () => active,
        setIntervalRef: (callback) => { tick = callback; return 9; },
        clearIntervalRef: (id) => { cleared = id === 9; },
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) { safetyRequests += 1; return { ok: true, json: async () => ({ safety: { state: safetyState } }) }; }
            if (url.endsWith('integrity-report')) { reportRequests += 1; return { ok: false, status: 404 }; }
            scans += 1;
            if (scans === 3) safetyState = 'healthy';
            return { ok: true, json: async () => ({ complete: scans === 3, checkpoint: { sourceIndex: scans } }) };
        }
    });
    await Promise.all([controller.startMonitoring(), controller.startMonitoring()]);
    assert.equal(scans, 3);
    assert.equal(safetyRequests, 2);
    assert.equal(reportRequests, 2);
    assert.equal(controller.getState().model.paused, false);
    assert.equal(controller.getState().error, '');
    await controller.refresh();
    assert.equal(scans, 3);
    active = false;
    await tick();
    assert.equal(cleared, true);
});

test('an interrupted automatic scan resumes when the panel becomes visible again', async () => {
    let visible = true; let tick; let scans = 0;
    const controller = createMediaIntegrityDrawerController({
        shouldPoll: () => visible,
        setIntervalRef: (callback) => { tick = callback; return 10; },
        clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({ safety: { state: 'scanning' } }) };
            if (url.endsWith('integrity-report')) return { ok: false, status: 404 };
            scans += 1;
            if (scans === 1) visible = false;
            return { ok: true, json: async () => ({ complete: scans === 2 }) };
        }
    });
    await controller.startMonitoring();
    assert.equal(scans, 1);
    await tick();
    assert.equal(scans, 1);
    visible = true;
    await tick();
    assert.equal(scans, 2);
    controller.stopMonitoring();
});

test('monitor starts a scan when backend safety changes while the drawer stays open', async () => {
    let safetyState = 'healthy'; let tick; let scans = 0; let safetyRequests = 0;
    const controller = createMediaIntegrityDrawerController({
        setIntervalRef: (callback) => { tick = callback; return 11; }, clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) { safetyRequests += 1; return { ok: true, json: async () => ({ safety: { state: safetyState } }) }; }
            if (url.endsWith('integrity-report')) return { ok: false, status: 404 };
            scans += 1;
            safetyState = 'healthy';
            return { ok: true, json: async () => ({ complete: true }) };
        }
    });
    await controller.startMonitoring();
    assert.equal(scans, 0);
    safetyState = 'scanning';
    await tick();
    assert.equal(scans, 1);
    assert.equal(safetyRequests, 3);
    controller.stopMonitoring();
});

test('monitor rescans after orphan deletion even when its previous scan was complete', async () => {
    let safetyState = 'healthy'; let reportId = 'previous'; let tick; let scans = 0;
    const controller = createMediaIntegrityDrawerController({
        setIntervalRef: (callback) => { tick = callback; return 13; }, clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({
                safety: { state: safetyState, reportId }
            }) };
            if (url.endsWith('integrity-report')) return { ok: true, json: async () => ({
                report: reportId ? { reportId } : null
            }) };
            scans += 1;
            return { ok: true, json: async () => ({ complete: true }) };
        }
    });
    await controller.startMonitoring();
    await controller.refresh({ recheck: true });
    assert.equal(scans, 1);
    safetyState = 'scan_required'; reportId = '';
    await tick();
    assert.equal(scans, 2);
    controller.stopMonitoring();
});

test('opening cache rechecks an unclean shutdown even when an old integrity report exists', async () => {
    let safetyState = 'gc_suspended'; let scans = 0;
    const controller = createMediaIntegrityDrawerController({
        setIntervalRef: () => 14, clearIntervalRef: () => {},
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({
                safety: { state: safetyState, reason: safetyState === 'healthy' ? 'integrity_scan_complete' : 'unclean_shutdown', reportId: 'old' }
            }) };
            if (url.endsWith('integrity-report')) return { ok: true, json: async () => ({ report: { reportId: 'old' } }) };
            scans += 1;
            safetyState = 'healthy';
            return { ok: true, json: async () => ({ complete: true }) };
        }
    });

    await controller.startMonitoring();

    assert.equal(scans, 1);
    assert.equal(controller.getState().safety.state, 'healthy');
    controller.stopMonitoring();
});

test('a recovery recheck is not lost behind an ordinary in-flight refresh', async () => {
    let releaseStatus; let scans = 0;
    const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
    const controller = createMediaIntegrityDrawerController({
        fetchRef: async (url) => {
            if (url.endsWith('safety-status')) {
                await statusGate;
                return { ok: true, json: async () => ({ safety: { state: 'healthy' } }) };
            }
            if (url.endsWith('integrity-report')) return { ok: false, status: 404 };
            scans += 1;
            return { ok: true, json: async () => ({ complete: true }) };
        }
    });
    const ordinary = controller.refresh();
    const recheck = controller.refresh({ recheck: true });
    releaseStatus();
    await Promise.all([ordinary, recheck]);
    assert.equal(scans, 1);
});

test('controller pauses, resumes and retries through bounded backend scans', async () => {
    const requests = [];
    const controller = createMediaIntegrityDrawerController({
        fetchRef: async (url, options = {}) => {
            requests.push([url, options.body && JSON.parse(options.body)]);
            if (url.endsWith('safety-status')) return { ok: true, json: async () => ({ safety }) };
            if (url.endsWith('integrity-report')) return { ok: true, json: async () => ({ report: null }) };
            return { ok: true, json: async () => ({ success: true, complete: false, checkpoint: { cutoffRevision: 3 } }) };
        }, getWorkflows: () => [{ workflowId: 'workflow-a' }]
    });
    await controller.load();
    controller.pause();
    await controller.step();
    controller.resume();
    await controller.step();
    await controller.retry();
    assert.equal(requests.filter(([url]) => url.endsWith('/maintenance')).length, 2);
    assert.equal(requests.filter(([url]) => url.endsWith('/maintenance')).at(-1)[1].action, 'scan-media-integrity');
});

test('action failure and version conflict remain visible while save stays unblocked', async () => {
    const controller = createMediaIntegrityDrawerController({
        fetchRef: async (url) => url.endsWith('safety-status')
            ? { ok: true, json: async () => ({ safety }) }
            : { ok: true, json: async () => ({ report: null }) },
        onMissingAction: async () => { throw new Error('工作流版本已变化'); }
    });
    await controller.load();
    await controller.runMissingAction('remove', {}, {});
    assert.match(controller.getState().error, /版本已变化/);
    assert.equal(controller.getState().model.editingBlocked, false);
});
