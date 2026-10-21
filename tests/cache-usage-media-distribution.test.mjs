import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeneralSettings } from '../js/features/settings/general-settings.js';

test('cache usage separates unique physical media from overlapping owner distribution', async () => {
    const originalFetch = globalThis.fetch;
    const elements = new Map(['cache-size-display', 'usage-workflow-media', 'usage-import-media', 'usage-history', 'usage-thumbnail-media', 'usage-operation-media', 'usage-local']
        .map((id) => [id, { textContent: '' }]));
    let requestedUrl = '';
    globalThis.fetch = async (url) => (requestedUrl = url, { ok: true, json: async () => ({
        actualMediaBytes: 1024 * 1024,
        documentBytes: 128,
        mediaReferenceDistribution: {
            'workflow-node': { assets: 2, bytes: 1024 * 1024 },
            'workflow-operation': { assets: 1, bytes: 512 * 1024 },
            history: { assets: 1, bytes: 1024 * 1024 }
        }
    }) });
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets', getActiveWorkflowId: () => 'workflow-a', documentRef: { getElementById: (id) => elements.get(id) || null } },
            dialogs: {}
        });
        await api.updateCacheUsage();
        assert.equal(elements.get('cache-size-display').textContent, '1.00 MB');
        assert.equal(elements.get('usage-workflow-media').textContent, '2 项 · 1.00 MB');
        assert.equal(elements.get('usage-history').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-import-media').textContent, '0 项 · 0.00 MB');
        assert.equal(elements.get('usage-operation-media').textContent, '1 项 · 0.50 MB');
        assert.match(requestedUrl, /workflowId=workflow-a/);
    } finally { globalThis.fetch = originalFetch; }
});

test('cache usage identifies media retained by other workflows, undo and pending collection', async () => {
    const originalFetch = globalThis.fetch;
    const elements = new Map([
        'cache-size-display', 'usage-workflow-media', 'usage-all-workflows',
        'usage-undo-media', 'usage-operation-media', 'usage-other-media',
        'usage-unreferenced-media'
    ].map((id) => [id, { textContent: '' }]));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
        actualMediaBytes: 5 * 1024 * 1024,
        mediaReferenceDistribution: {},
        mediaPhysicalBreakdown: {
            workflows: { assets: 1, bytes: 1024 * 1024 },
            undo: { assets: 1, bytes: 1024 * 1024 },
            operations: { assets: 1, bytes: 1024 * 1024 },
            other: { assets: 1, bytes: 1024 * 1024 },
            unreferenced: { assets: 1, bytes: 1024 * 1024 }
        }
    }) });
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets',
                getActiveWorkflowId: () => 'workflow-a',
                documentRef: { getElementById: (id) => elements.get(id) || null } },
            dialogs: {}
        });
        await api.updateCacheUsage();
        assert.equal(elements.get('cache-size-display').textContent, '5.00 MB');
        assert.equal(elements.get('usage-workflow-media').textContent, '0 项 · 0.00 MB');
        assert.equal(elements.get('usage-all-workflows').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-undo-media').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-operation-media').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-other-media').textContent, '1 项 · 1.00 MB');
        assert.equal(elements.get('usage-unreferenced-media').textContent, '1 项 · 1.00 MB');
    } finally { globalThis.fetch = originalFetch; }
});

test('cache usage coalesces background polls and keeps the newest forced refresh', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [];
    const display = { textContent: '' };
    globalThis.fetch = () => new Promise((resolve) => responses.push(resolve));
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets',
                getActiveWorkflowId: () => '', documentRef: { getElementById: (id) => id === 'cache-size-display' ? display : null } },
            dialogs: {}
        });
        const first = api.updateCacheUsage();
        const duplicate = api.updateCacheUsage();
        assert.equal(responses.length, 1);
        const latest = api.updateCacheUsage(true);
        assert.equal(responses.length, 2);
        responses[1]({ ok: true, json: async () => ({ actualMediaBytes: 2 * 1024 * 1024 }) });
        await latest;
        responses[0]({ ok: true, json: async () => ({ actualMediaBytes: 1024 * 1024 }) });
        await Promise.all([first, duplicate]);
        assert.equal(display.textContent, '2.00 MB');
    } finally { globalThis.fetch = originalFetch; }
});

test('switching workflows starts a new usage request instead of reusing the previous one', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [];
    const display = { textContent: '' };
    let workflowId = 'first';
    globalThis.fetch = (url) => new Promise((resolve) => responses.push({ url, resolve }));
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets',
                getActiveWorkflowId: () => workflowId, documentRef: { getElementById: (id) => id === 'cache-size-display' ? display : null } },
            dialogs: {}
        });
        const first = api.updateCacheUsage();
        workflowId = 'second';
        const second = api.updateCacheUsage();
        assert.equal(responses.length, 2);
        assert.match(responses[1].url, /workflowId=second/);
        responses[1].resolve({ ok: true, json: async () => ({ actualMediaBytes: 3 * 1024 * 1024 }) });
        await second;
        responses[0].resolve({ ok: true, json: async () => ({ actualMediaBytes: 1024 * 1024 }) });
        await first;
        assert.equal(display.textContent, '3.00 MB');
    } finally { globalThis.fetch = originalFetch; }
});

test('background cache changes skip the closed drawer and opening forces a fresh audit', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const display = { textContent: '' };
    const sidebar = { classList: { contains: () => false } };
    globalThis.fetch = async () => {
        requests += 1;
        return { ok: true, json: async () => ({ actualMediaBytes: 1024 * 1024 }) };
    };
    try {
        const api = createGeneralSettings({
            ctx: { state: { cacheSizes: {} }, storeHistoryName: 'history', storeAssetsName: 'assets',
                getActiveWorkflowId: () => '', documentRef: { getElementById: (id) => ({
                    'cache-sidebar': sidebar, 'cache-size-display': display
                })[id] || null } },
            dialogs: {}
        });
        await api.updateCacheUsage();
        assert.equal(requests, 0);
        await api.updateCacheUsage(true);
        assert.equal(requests, 1);
        assert.equal(display.textContent, '1.00 MB');
    } finally { globalThis.fetch = originalFetch; }
});

test('Agent cache updates from live context without waiting for or repeating the disk audit', async () => {
    const originalFetch = globalThis.fetch;
    const elements = new Map([
        'cache-size-display', 'usage-agent', 'usage-agent-current', 'usage-agent-detail', 'usage-agent-context'
    ].map((id) => [id, { textContent: '' }]));
    let open = true;
    elements.set('cache-sidebar', { classList: { contains: () => open } });
    const image = { name: '参考图', dataUrl: 'data:image/png;base64,AAAA' };
    let activeConversation = {
        memory: '新补充', contextSummary: '已有摘要',
        messages: [{ role: 'user', text: '最新要求', referenceImages: [image] }],
        archivedMessages: [{ role: 'user', text: '早期要求', referenceImages: [image] }],
        referenceImages: [image]
    };
    const workflows = [{ workflowId: 'active', data: { promptAgent: {
        messages: Array.from({ length: 20 }, () => ({ role: 'user', text: '已被替换的旧快照' }))
    } } }];
    let finishAudit;
    let requests = 0;
    globalThis.fetch = () => {
        requests += 1;
        return new Promise((resolve) => { finishAudit = resolve; });
    };
    try {
        const api = createGeneralSettings({
            ctx: {
                state: { cacheSizes: {} }, getActiveWorkflowId: () => 'active',
                getPromptAgentCacheState: () => ({ workflows, activeWorkflowId: 'active', activeConversation }),
                documentRef: { getElementById: (id) => elements.get(id) || null }
            }, dialogs: {}
        });
        const pending = api.updateCacheUsage();
        assert.equal(requests, 1);
        assert.equal(elements.get('usage-agent-detail').textContent, '1 个场景 · 2 条消息 · 1 张参考图 · 0 张生成图');
        assert.equal(elements.get('usage-agent-context').textContent, '上下文 1 条 · 归档 1 条 · 摘要 2 份');
        assert.notEqual(elements.get('usage-agent').textContent, '0 B');

        activeConversation = { memory: '', messages: [], panelWidth: 612 };
        api.updateAgentCacheUsage();
        assert.equal(requests, 1);
        assert.equal(elements.get('usage-agent').textContent, '0 B');
        assert.equal(elements.get('usage-agent-current').textContent, '0 B');
        finishAudit({ ok: true, json: async () => ({ actualMediaBytes: 1024 * 1024 }) });
        await pending;
        assert.equal(elements.get('cache-size-display').textContent, '1.00 MB');
        assert.equal(elements.get('usage-agent').textContent, '0 B');

        open = false;
        activeConversation = { messages: [{ role: 'user', text: '关闭期间新增消息' }] };
        api.updateAgentCacheUsage();
        assert.equal(elements.get('usage-agent').textContent, '0 B');
        api.updateAgentCacheUsage(true);
        assert.notEqual(elements.get('usage-agent').textContent, '0 B');
        assert.equal(elements.get('usage-agent-detail').textContent, '1 个场景 · 1 条消息 · 0 张参考图 · 0 张生成图');
        assert.equal(requests, 1);
    } finally { globalThis.fetch = originalFetch; }
});
