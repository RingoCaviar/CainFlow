import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getWorkflowMoveEligibility,
    hasRunningWorkflowInFolder,
    moveFolderWorkflowsToRoot,
    persistEligibleWorkflowMoves,
    persistWorkflowRenameIfEligible
} from '../js/features/workflow/workflow-folder-policy.js';

test('workflow move eligibility rejects every move containing a background run', () => {
    assert.deepEqual(getWorkflowMoveEligibility(['idle', 'running'], {
        runningWorkflowNames: ['running']
    }), { allowed: false, reason: 'running' });
});

test('rename rechecks background run eligibility at persistence time', async () => {
    const runningWorkflowNames = [];
    let persisted = false;
    const confirm = Promise.resolve().then(() => { runningWorkflowNames.push('folder/a'); });
    await confirm;

    const result = await persistWorkflowRenameIfEligible(['folder/a'], {
        runningWorkflowNames,
        persist: async () => { persisted = true; return true; }
    });

    assert.deepEqual(result, { allowed: false, result: null, reason: 'running' });
    assert.equal(persisted, false);
});

test('batch move rechecks each workflow immediately before persistence', async () => {
    const runningWorkflowNames = [];
    const persisted = [];

    const result = await persistEligibleWorkflowMoves([
        { name: 'folder/a', nextName: 'target/a' },
        { name: 'folder/b', nextName: 'target/b' }
    ], {
        runningWorkflowNames: () => runningWorkflowNames,
        persist: async ({ name }) => {
            persisted.push(name);
            if (name === 'folder/a') runningWorkflowNames.push('folder/b');
            return true;
        }
    });

    assert.deepEqual(persisted, ['folder/a']);
    assert.deepEqual(result, {
        moved: [{ name: 'folder/a', nextName: 'target/a' }],
        failed: [],
        blocked: [{ name: 'folder/b', nextName: 'target/b' }]
    });
});

test('parent folder rename is blocked by a background workflow run in a nested folder', () => {
    const folders = [
        { id: 'parent', items: ['parent/direct'] },
        { id: 'parent/child', items: ['parent/child/running'] },
        { id: 'other', items: ['other/running'] }
    ];
    assert.equal(hasRunningWorkflowInFolder('parent', {
        folders,
        runningWorkflowNames: ['parent/child/running', 'other/running']
    }), true);
});

test('folder rename ignores background workflow runs outside its subtree', () => {
    const folders = [
        { id: 'parent', items: ['parent/direct'] },
        { id: 'other', items: ['other/running'] }
    ];
    assert.equal(hasRunningWorkflowInFolder('parent', {
        folders,
        runningWorkflowNames: ['other/running']
    }), false);
});

test('deleting only a folder cannot move a background workflow to the root', async () => {
    let persisted = false;
    const result = await moveFolderWorkflowsToRoot('parent', {
        folders: [{ id: 'parent', items: ['parent/running'] }],
        runningWorkflowNames: ['parent/running'],
        persistMove: async () => {
            persisted = true;
            return { moved: ['running'] };
        }
    });

    assert.equal(result.allowed, false);
    assert.equal(persisted, false);
});
