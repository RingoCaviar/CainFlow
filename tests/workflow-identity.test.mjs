import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ensureUniqueWorkflowIdentities,
    isWorkflowReferenceActive,
    normalizeWorkflowReference
} from '../js/features/workflow/workflow-identity.js';

test('imported workflow identity collisions are replaced without changing the original', () => {
    const tabs = [
        { name: 'original', workflowId: 'same-id', data: { workflowId: 'same-id' } },
        { name: 'imported-copy', workflowId: 'same-id', data: { workflowId: 'same-id' } }
    ];
    const generated = ['replacement-id'];

    ensureUniqueWorkflowIdentities(tabs, () => generated.shift());

    assert.equal(tabs[0].workflowId, 'same-id');
    assert.equal(tabs[1].workflowId, 'replacement-id');
    assert.equal(tabs[1].data.workflowId, 'replacement-id');
});

test('legacy workflows receive identities lazily', () => {
    const tabs = [{ name: 'legacy', data: {} }];
    ensureUniqueWorkflowIdentities(tabs, () => 'generated-id');
    assert.equal(tabs[0].workflowId, 'generated-id');
    assert.equal(tabs[0].data.workflowId, 'generated-id');
});

test('workflow references prefer stable identity over mutable names', () => {
    const reference = normalizeWorkflowReference({ workflowId: 'workflow-a', workflowName: 'old-name' });
    assert.equal(isWorkflowReferenceActive(reference, {
        activeWorkflowId: 'workflow-a',
        activeWorkflowName: 'new-name'
    }), true);
});
