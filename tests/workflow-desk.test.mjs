import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WorkflowCommitRecoveryError,
    WorkflowEditorCommitError,
    WorkflowEditorPrepareError,
    createWorkflowDesk
} from '../js/features/workflow/workflow-desk.js';

function createHarness() {
    const committedViews = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => ({
            workflowId: selection.workflowId,
            label: selection.label,
            document: { workflowId: selection.workflowId }
        }),
        prepareEditorView: async ({ workflowId }) => ({
            async commit() { committedViews.push(workflowId); return true; },
            rollback() { return true; },
            finalize() { return true; },
            dispose() { return true; }
        })
    });
    return { desk, committedViews };
}

test('show publishes one immutable committed Workflow activation snapshot', async () => {
    const { desk, committedViews } = createHarness();

    const result = await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const snapshot = desk.snapshot();

    assert.equal(result.status, 'committed');
    assert.deepEqual(committedViews, ['workflow-a']);
    assert.deepEqual(snapshot.active, {
        workflowId: 'workflow-a',
        label: 'A',
        editorView: result.active.editorView,
        revision: 1
    });
    assert.deepEqual(snapshot.open, [{
        workflowId: 'workflow-a',
        label: 'A',
        pendingExplicitSave: false,
        running: false
    }]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.active), true);
    assert.equal(Object.isFrozen(snapshot.open), true);
});

test('only the latest of three prepared Workflow activations commits', async () => {
    const preparations = new Map();
    const commits = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: ({ workflowId }) => new Promise((resolve) => {
            preparations.set(workflowId, () => resolve({
                async commit() { commits.push(workflowId); return true; },
                dispose() { return true; }
            }));
        })
    });

    const first = desk.show({ workflowId: 'workflow-a', label: 'A' });
    const second = desk.show({ workflowId: 'workflow-b', label: 'B' });
    const third = desk.show({ workflowId: 'workflow-c', label: 'C' });
    await Promise.resolve();

    preparations.get('workflow-a')();
    preparations.get('workflow-b')();
    preparations.get('workflow-c')();

    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'superseded');
    assert.equal((await third).status, 'committed');
    assert.deepEqual(commits, ['workflow-c']);
    assert.equal(desk.snapshot().active.workflowId, 'workflow-c');
});

test('preparing another Workflow leaves the committed snapshot untouched', async () => {
    let releasePreparation;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => {
            if (workflowId === 'workflow-b') {
                await new Promise((resolve) => { releasePreparation = resolve; });
            }
            return {
                async commit() { return true; },
                finalize() { return true; }
            };
        }
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const before = desk.snapshot();

    const pending = desk.show({ workflowId: 'workflow-b', label: 'B' });
    await Promise.resolve();

    assert.equal(desk.snapshot(), before);
    assert.equal(desk.snapshot().active.workflowId, 'workflow-a');
    releasePreparation();
    await pending;
});

test('show reports already-visible without preparing another editor view', async () => {
    let preparations = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async () => {
            preparations += 1;
            return {
                async commit() { return true; },
                finalize() { return true; }
            };
        }
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const before = desk.snapshot();

    const result = await desk.show({ workflowId: 'workflow-a', label: 'A' });

    assert.equal(result.status, 'already-visible');
    assert.equal(preparations, 1);
    assert.equal(desk.snapshot(), before);
});

test('failed editor commit rolls back and preserves the previous committed Workflow', async () => {
    let rolledBack = false;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() { return workflowId === 'workflow-a'; },
            rollback() { rolledBack = true; return true; },
            finalize() { return true; }
        })
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const before = desk.snapshot();

    await assert.rejects(
        desk.show({ workflowId: 'workflow-b', label: 'B' }),
        WorkflowEditorCommitError
    );

    assert.equal(rolledBack, true);
    assert.equal(desk.snapshot(), before);
    assert.equal(desk.snapshot().active.workflowId, 'workflow-a');
});

test('failed commit and recovery atomically publish safe-empty with a diagnostic', async () => {
    const diagnostics = [];
    let safeEmptyCommits = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() { return workflowId === 'workflow-a'; },
            rollback() { return workflowId === 'workflow-a'; },
            finalize() { return true; }
        }),
        commitSafeEmpty: async () => { safeEmptyCommits += 1; },
        recordDiagnostic: async (record) => { diagnostics.push(record); }
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });

    await assert.rejects(
        desk.show({ workflowId: 'workflow-b', label: 'B' }),
        WorkflowCommitRecoveryError
    );

    assert.equal(safeEmptyCommits, 1);
    assert.equal(desk.snapshot().active, null);
    assert.equal(desk.snapshot().revision, 2);
    assert.deepEqual(diagnostics.map((record) => record.kind), ['workflow-commit-recovery-failed']);
});

test('failed editor preparation preserves the previous committed Workflow', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => {
            if (workflowId === 'workflow-b') throw new Error('media restore failed');
            return { async commit() { return true; }, finalize() { return true; } };
        }
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const before = desk.snapshot();

    await assert.rejects(
        desk.show({ workflowId: 'workflow-b', label: 'B' }),
        WorkflowEditorPrepareError
    );

    assert.equal(desk.snapshot(), before);
});

test('finalize and diagnostic failures cannot undo a committed Workflow activation', async () => {
    let diagnostics = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async () => ({
            async commit() { return true; },
            finalize() { throw new Error('cleanup failed'); }
        }),
        recordDiagnostic: async () => {
            diagnostics += 1;
            throw new Error('diagnostic storage unavailable');
        }
    });

    const result = await desk.show({ workflowId: 'workflow-a', label: 'A' });

    assert.equal(result.status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'workflow-a');
    assert.equal(diagnostics, 1);
});

test('Workflow editor commits are serialized when a newer activation arrives mid-commit', async () => {
    let releaseFirstCommit;
    let firstCommitStarted;
    const firstStarted = new Promise((resolve) => { firstCommitStarted = resolve; });
    const visible = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() {
                visible.push(`commit:${workflowId}`);
                if (workflowId === 'workflow-a') {
                    firstCommitStarted();
                    await new Promise((resolve) => { releaseFirstCommit = resolve; });
                }
                return true;
            },
            rollback() { visible.push(`rollback:${workflowId}`); return true; },
            finalize() { return true; }
        })
    });

    const first = desk.show({ workflowId: 'workflow-a', label: 'A' });
    await firstStarted;
    const second = desk.show({ workflowId: 'workflow-b', label: 'B' });
    await Promise.resolve();
    assert.deepEqual(visible, ['commit:workflow-a']);

    releaseFirstCommit();

    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'committed');
    assert.deepEqual(visible, [
        'commit:workflow-a',
        'rollback:workflow-a',
        'commit:workflow-b'
    ]);
});

test('superseded editor preparation failure is an expected result', async () => {
    let rejectFirst;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: ({ workflowId }) => {
            if (workflowId === 'workflow-a') {
                return new Promise((_, reject) => { rejectFirst = reject; });
            }
            return Promise.resolve({
                async commit() { return true; },
                finalize() { return true; }
            });
        }
    });

    const first = desk.show({ workflowId: 'workflow-a', label: 'A' });
    await Promise.resolve();
    const second = desk.show({ workflowId: 'workflow-b', label: 'B' });
    rejectFirst(new Error('stale preparation failed'));

    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'committed');
});

test('safe-empty adapter failure still reports a typed recovery failure', async () => {
    let targetWorkflowId = '';
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() { targetWorkflowId = workflowId; return workflowId === 'workflow-a'; },
            rollback() { return false; }
        }),
        commitSafeEmpty: async () => { throw new Error('visible editor could not clear'); }
    });
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    const before = desk.snapshot();

    await assert.rejects(
        desk.show({ workflowId: 'workflow-b', label: 'B' }),
        WorkflowCommitRecoveryError
    );
    assert.equal(targetWorkflowId, 'workflow-b');
    assert.equal(desk.snapshot(), before);
});

test('superseded failed commit rolls back before the newer Workflow can commit', async () => {
    let releaseFirstCommit;
    let firstCommitStarted;
    const firstStarted = new Promise((resolve) => { firstCommitStarted = resolve; });
    const visible = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() {
                visible.push(`commit:${workflowId}`);
                if (workflowId === 'workflow-a') {
                    firstCommitStarted();
                    await new Promise((resolve) => { releaseFirstCommit = resolve; });
                    return false;
                }
                return true;
            },
            rollback() { visible.push(`rollback:${workflowId}`); return true; },
            dispose() { visible.push(`dispose:${workflowId}`); return true; },
            finalize() { return true; }
        })
    });

    const first = desk.show({ workflowId: 'workflow-a', label: 'A' });
    await firstStarted;
    const second = desk.show({ workflowId: 'workflow-b', label: 'B' });
    releaseFirstCommit();

    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'committed');
    assert.deepEqual(visible, [
        'commit:workflow-a',
        'rollback:workflow-a',
        'commit:workflow-b'
    ]);
});
