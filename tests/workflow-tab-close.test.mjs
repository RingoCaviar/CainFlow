import test from 'node:test';
import assert from 'node:assert/strict';
import { removeWorkflowTabsTransaction } from '../js/features/workflow/workflow-tab-close.js';

test('workflow removal keeps every target tab intact when fallback activation fails', async () => {
    const activeData = { nodes: [{ id: 'active-node' }] };
    const tabs = [
        { name: 'active', data: activeData },
        { name: 'also-deleted', data: { nodes: [] } },
        { name: 'fallback', data: { nodes: [] } }
    ];
    const events = [];

    const result = await removeWorkflowTabsTransaction({
        tabs,
        names: ['active', 'also-deleted'],
        activeWorkflowName: 'active',
        activateFallback: async () => { events.push('activate'); return false; },
        persistRemoval: async () => { events.push('persist'); return []; },
        releaseTab: (tab) => events.push(`release:${tab.name}`)
    });

    assert.equal(result.removed, false);
    assert.equal(result.tabs, tabs);
    assert.equal(tabs[0].data, activeData);
    assert.deepEqual(events, ['activate']);
});

test('workflow removal releases target tabs only after fallback activation succeeds', async () => {
    const tabs = [
        { name: 'active', data: {} },
        { name: 'also-deleted', data: {} },
        { name: 'fallback', data: {} }
    ];
    const events = [];

    const result = await removeWorkflowTabsTransaction({
        tabs,
        names: ['active', 'also-deleted'],
        activeWorkflowName: 'active',
        activateFallback: async () => { events.push('activate'); return true; },
        persistRemoval: async (names) => {
            events.push(`persist:${names.join(',')}`);
            return names;
        },
        releaseTab: (tab) => events.push(`release:${tab.name}`)
    });

    assert.equal(result.removed, true);
    assert.deepEqual(result.tabs.map((tab) => tab.name), ['fallback']);
    assert.deepEqual(events, [
        'activate',
        'persist:active,also-deleted',
        'release:active',
        'release:also-deleted'
    ]);
});

test('workflow removal restores the previous active workflow when persistence keeps it', async () => {
    const tabs = [
        { name: 'active', data: {} },
        { name: 'temporary-fallback', data: {} }
    ];
    const events = [];

    const result = await removeWorkflowTabsTransaction({
        tabs,
        names: ['active'],
        activeWorkflowName: 'active',
        activateFallback: async () => { events.push('activate-fallback'); return true; },
        persistRemoval: async () => { events.push('persist'); return []; },
        rollbackFallback: async () => { events.push('restore-active-and-cleanup-fallback'); return true; }
    });

    assert.equal(result.removed, false);
    assert.equal(result.activated, false);
    assert.equal(result.restored, true);
    assert.deepEqual(result.tabs, tabs);
    assert.deepEqual(events, [
        'activate-fallback',
        'persist',
        'restore-active-and-cleanup-fallback'
    ]);
});

test('closing a workflow view preserves its missing Media asset reference list', async () => {
    const referenceList = ['media:present', 'media:missing', 'media:present'];
    const closedTab = {
        name: 'damaged',
        data: { nodes: [{ id: 'node-a', mediaAssetKeys: referenceList.slice(), mediaIntegrity: { state: 'missing' } }] }
    };
    let releasedView = null;
    const result = await removeWorkflowTabsTransaction({
        tabs: [closedTab, { name: 'fallback', data: { nodes: [] } }],
        names: ['damaged'],
        activeWorkflowName: 'damaged',
        activateFallback: async () => true,
        persistRemoval: async (names) => names,
        releaseTab: (tab) => { releasedView = tab; }
    });

    assert.equal(result.removed, true);
    assert.deepEqual(closedTab.data.nodes[0].mediaAssetKeys, referenceList);
    assert.equal(releasedView, closedTab);
});
