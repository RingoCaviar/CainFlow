import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ensureWorkflowDocumentIdentity,
    normalizeWorkflowReference,
    requireStableWorkflowReference
} from '../js/features/workflow/workflow-identity.js';

test('legacy workflows receive identities lazily', () => {
    const tab = { name: 'legacy', data: {} };
    ensureWorkflowDocumentIdentity(tab, () => 'generated-id');
    assert.equal(tab.workflowId, 'generated-id');
    assert.equal(tab.data.workflowId, 'generated-id');
});

test('normalized workflow references require identity and ignore mutable labels', () => {
    const reference = normalizeWorkflowReference({ workflowId: 'workflow-a', workflowName: 'old-name' });
    assert.deepEqual(requireStableWorkflowReference(reference), reference);
    assert.deepEqual(normalizeWorkflowReference('old-name'), {
        workflowName: '',
        workflowId: ''
    });
    assert.throws(() => requireStableWorkflowReference({ workflowName: 'new-name' }), TypeError);
});
