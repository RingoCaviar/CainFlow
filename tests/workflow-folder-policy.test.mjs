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
        tabs: [
            { name: 'idle', running: false },
            { name: 'running', running: true }
        ]
    }), { allowed: false, reason: 'running' });
});

test('rename rechecks background run eligibility at persistence time', async () => {
    const tabs = [{ name: 'folder/a', running: false }];
    let persisted = false;
    const confirm = Promise.resolve().then(() => { tabs[0].running = true; });
    await confirm;

    const result = await persistWorkflowRenameIfEligible(['folder/a'], {
        tabs,
        persist: async () => { persisted = true; return true; }
    });

    assert.deepEqual(result, { allowed: false, result: null, reason: 'running' });
    assert.equal(persisted, false);
});

test('batch move rechecks each workflow immediately before persistence', async () => {
    const tabs = [
        { name: 'folder/a', running: false },
        { name: 'folder/b', running: false }
    ];
    const persisted = [];

    const result = await persistEligibleWorkflowMoves([
        { name: 'folder/a', nextName: 'target/a' },
        { name: 'folder/b', nextName: 'target/b' }
    ], {
        tabs,
        persist: async ({ name }) => {
            persisted.push(name);
            if (name === 'folder/a') tabs[1].running = true;
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
    const tabs = [
        { name: 'parent/direct', running: false },
        { name: 'parent/child/running', running: true },
        { name: 'other/running', running: true }
    ];

    assert.equal(hasRunningWorkflowInFolder('parent', { folders, tabs }), true);
});

test('folder rename ignores background workflow runs outside its subtree', () => {
    const folders = [
        { id: 'parent', items: ['parent/direct'] },
        { id: 'other', items: ['other/running'] }
    ];
    const tabs = [
        { name: 'parent/direct', running: false },
        { name: 'other/running', running: true }
    ];

    assert.equal(hasRunningWorkflowInFolder('parent', { folders, tabs }), false);
});

test('deleting only a folder cannot move a background workflow to the root', async () => {
    let persisted = false;
    const result = await moveFolderWorkflowsToRoot('parent', {
        folders: [{ id: 'parent', items: ['parent/running'] }],
        tabs: [{ name: 'parent/running', running: true }],
        persistMove: async () => {
            persisted = true;
            return { moved: ['running'] };
        }
    });

    assert.equal(result.allowed, false);
    assert.equal(persisted, false);
});
