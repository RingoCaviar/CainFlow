import test from 'node:test';
import assert from 'node:assert/strict';
import {
    captureWorkflowTabRevision,
    retainActiveWorkflowTabDuringRefresh,
    replaceWorkflowTabData
} from '../js/features/workflow/workflow-tab-revision.js';

test('workflow activation can detect a background result that replaces its prepared target snapshot', () => {
    const tab = { data: { nodes: [{ id: 'before' }] } };
    const prepared = captureWorkflowTabRevision(tab);

    replaceWorkflowTabData(tab, { nodes: [{ id: 'latest-run-result' }] });

    assert.equal(prepared.isCurrent(), false);
    assert.equal(tab.data.nodes[0].id, 'latest-run-result');
});

test('workflow revision follows stable identity when tab normalization replaces the object', () => {
    const tabs = [{ workflowId: 'wf-1', data: { nodes: [{ id: 'before' }] }, dataRevision: 3 }];
    const prepared = captureWorkflowTabRevision(tabs[0], {
        resolveTab: (workflowId) => tabs.find((tab) => tab.workflowId === workflowId)
    });
    tabs[0] = { ...tabs[0] };

    replaceWorkflowTabData(tabs[0], { nodes: [{ id: 'latest' }] });

    assert.equal(prepared.isCurrent(), false);
});

test('a newly loaded detached workflow tab remains valid until its first commit', () => {
    const detachedTab = {
        workflowId: 'wf-detached',
        data: { nodes: [{ id: 'loaded-from-disk' }] },
        dataRevision: 0
    };
    const openTabs = [];
    const prepared = captureWorkflowTabRevision(detachedTab, {
        resolveTab: (workflowId) => openTabs.find((tab) => tab.workflowId === workflowId) || null,
        allowDetached: true
    });

    assert.equal(prepared.isCurrent(), true);
});

test('workflow list refresh retains the active workflow until another activation commits', () => {
    const active = { workflowId: 'wf-active', name: 'folder/active', data: { nodes: [] } };
    const inactive = { workflowId: 'wf-inactive', name: 'folder/inactive', data: { nodes: [] } };

    const retained = retainActiveWorkflowTabDuringRefresh([active, inactive], ['folder/inactive'], {
        workflowId: 'wf-active',
        workflowName: 'folder/active'
    });

    assert.deepEqual(retained, [active, inactive]);
});
