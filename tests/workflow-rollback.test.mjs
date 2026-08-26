import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackWorkflowActivation } from '../js/features/workflow/workflow-rollback.js';

test('failed previous-view restoration still removes a newly-created target tab', async () => {
    const tabs = [{ name: 'previous' }, { name: 'target' }];
    const target = tabs[1];
    const result = await rollbackWorkflowActivation({
        prepared: { previous: { name: 'previous' }, tab: target, createdTab: true },
        restorePrevious: async () => { throw new Error('restore failed'); },
        cleanupCreatedTarget: () => tabs.splice(tabs.indexOf(target), 1),
        restoreExistingTarget: () => { throw new Error('not applicable'); },
        enterSafeEmpty: () => {},
        reveal: () => {},
        render: () => {}
    });

    assert.equal(result.safeEmpty, true);
    assert.deepEqual(tabs, [{ name: 'previous' }]);
});

test('failed previous-view restoration still restores an existing target snapshot', async () => {
    const target = { data: { value: 'failed transaction' }, dirty: false, runResult: '' };
    const original = { data: { value: 'original' }, dirty: true, runResult: 'success' };
    const result = await rollbackWorkflowActivation({
        prepared: { previous: {}, tab: target, previousTarget: original },
        restorePrevious: async () => false,
        cleanupCreatedTarget: () => {},
        restoreExistingTarget: () => Object.assign(target, original),
        enterSafeEmpty: () => {},
        reveal: () => {},
        render: () => {}
    });

    assert.equal(result.safeEmpty, true);
    assert.deepEqual(target, original);
});
