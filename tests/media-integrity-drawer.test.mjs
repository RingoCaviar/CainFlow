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

test('rendered loading state keeps ordered multi-image positions and explicit actions visible', () => {
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
    renderMediaIntegrityDrawer(root, { model, loading: true, error: '' });
    const all = []; const visit = (node) => { all.push(node); node.children.forEach(visit); }; visit(root);
    assert.match(all.map((item) => item.textContent).join('|'), /正在加载/);
    assert.match(all.map((item) => item.textContent).join('|'), /第 1 项/);
    assert.match(all.map((item) => item.textContent).join('|'), /第 2 项/);
    assert.ok(all.some((item) => item.textContent === '确认批量恢复'));
    assert.ok(all.some((item) => item.textContent === '确认移除'));
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
