import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WorkflowCommitRecoveryError,
    WorkflowEditorCommitError,
    WorkflowEditorPrepareError,
    WorkflowIdentityOwnershipError,
    createWorkflowDesk
} from '../js/features/workflow/workflow-desk.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

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
        revision: 1
    });
    assert.deepEqual(snapshot.open, [{
        workflowId: 'workflow-a',
        label: 'A',
        pendingExplicitSave: false,
        running: false,
        active: true
    }]);
    assert.deepEqual(snapshot.tabs, [{
        workflowId: 'workflow-a',
        name: 'A',
        identityPendingSave: false,
        running: false,
        active: true
    }]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.active), true);
    assert.equal(Object.isFrozen(snapshot.open), true);
    assert.equal(Object.isFrozen(snapshot.open[0]), true);
    assert.equal(Object.isFrozen(snapshot.tabs), true);
    assert.equal(Object.isFrozen(snapshot.tabs[0]), true);
    assert.equal('editorView' in snapshot.active, false);
});

test('snapshot-derived tab projection follows Open Workflow record authority', async () => {
    const { desk } = createHarness();
    await desk.show({ workflowId: 'workflow-a', label: 'A' });
    await desk.show({ workflowId: 'workflow-b', label: 'B' });

    const before = desk.snapshot();
    assert.deepEqual(before.tabs, [
        { workflowId: 'workflow-a', name: 'A', identityPendingSave: false, running: false, active: false },
        { workflowId: 'workflow-b', name: 'B', identityPendingSave: false, running: false, active: true }
    ]);

    desk.workflow('workflow-a').runningChanged(true);
    desk.workflow('workflow-a').labelChanged('renamed/A');

    assert.deepEqual(desk.snapshot().tabs, [
        { workflowId: 'workflow-a', name: 'renamed/A', identityPendingSave: false, running: true, active: false },
        { workflowId: 'workflow-b', name: 'B', identityPendingSave: false, running: false, active: true }
    ]);
    assert.equal(before.tabs[0].name, 'A');
    assert.equal(before.tabs[0].running, false);
});

test('identity-bound Workflow handle retains identity for save rename and move', async () => {
    const mutations = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async (operation) => { mutations.push(operation); return { ok: true }; }
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'folder/a',
        editorView: { async commit() { return true; } }
    });
    const workflow = desk.workflow('workflow-a');

    await workflow.save();
    await workflow.rename('folder/renamed');
    await workflow.move('other/renamed');

    assert.deepEqual(mutations.map(({ kind, workflowId }) => ({ kind, workflowId })), [
        { kind: 'save', workflowId: 'workflow-a' },
        { kind: 'rename', workflowId: 'workflow-a' },
        { kind: 'move', workflowId: 'workflow-a' }
    ]);
    assert.equal(desk.snapshot().active.workflowId, 'workflow-a');
    assert.equal(desk.snapshot().active.label, 'other/renamed');
});

test('Copy and Save As allocate new Workflow identities behind the handle seam', async () => {
    const generated = ['copy-id', 'save-as-id'];
    const mutations = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => generated.shift(),
        mutateWorkflow: async (operation) => { mutations.push(operation); return { ok: true }; }
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'a',
        editorView: { async commit() { return true; } }
    });

    const copied = await desk.workflow('workflow-a').copy('a copy');
    const savedAs = await desk.workflow('workflow-a').saveAs('a saved as');

    assert.equal(copied.workflowId, 'copy-id');
    assert.equal(savedAs.workflowId, 'save-as-id');
    assert.deepEqual(mutations.map(({ kind, newWorkflowId }) => ({ kind, newWorkflowId })), [
        { kind: 'copy', newWorkflowId: 'copy-id' },
        { kind: 'save-as', newWorkflowId: 'save-as-id' }
    ]);
    assert.equal(desk.snapshot().open.find(({ workflowId }) => workflowId === 'copy-id').pendingExplicitSave, false);
    assert.equal(desk.snapshot().open.find(({ workflowId }) => workflowId === 'save-as-id').pendingExplicitSave, false);
});

test('running and closed identity-bound Workflow handles fail explicitly', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async ({ kind }) => kind === 'close' ? { ok: true } : { ok: true }
    });
    await desk.restore({
        workflows: [{
            name: 'running',
            workflowId: 'workflow-running',
            running: true,
            data: { workflowId: 'workflow-running' }
        }]
    });
    const running = desk.workflow('workflow-running');

    await assert.rejects(() => running.rename('renamed'), { name: 'WorkflowRunningPolicyError' });
    await assert.rejects(() => running.move('folder/running'), { name: 'WorkflowRunningPolicyError' });
    await assert.rejects(() => running.reload(), { name: 'WorkflowRunningPolicyError' });
    await assert.rejects(() => running.close(), { name: 'WorkflowRunningPolicyError' });

    const missing = desk.workflow('missing-id');
    await assert.rejects(() => missing.save(), { name: 'WorkflowHandleClosedError' });
});

test('a closed identity-bound handle stays closed when the same identity opens again', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async () => ({ ok: true })
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'A',
        editorView: { async commit() { return true; } }
    });
    const closed = desk.workflow('workflow-a');
    await closed.close();
    await desk.show({
        workflowId: 'workflow-a',
        label: 'A reopened',
        editorView: { async commit() { return true; } }
    });

    await assert.rejects(() => closed.save(), { name: 'WorkflowHandleClosedError' });
    assert.throws(() => closed.documentSaved(), { name: 'WorkflowHandleClosedError' });
    assert.throws(() => closed.runningChanged(true), { name: 'WorkflowHandleClosedError' });
    assert.throws(() => closed.labelChanged('stale label'), { name: 'WorkflowHandleClosedError' });
    assert.equal((await desk.workflow('workflow-a').save()).status, 'committed');
});

test('an in-flight stale handle cannot mutate a replacement Open Workflow record', async () => {
    const closeGate = deferred();
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async ({ kind }) => kind === 'close' ? closeGate.promise : { ok: true }
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'original',
        editorView: { async commit() { return true; } }
    });
    const stale = desk.workflow('workflow-a');
    const closing = stale.close();

    await desk.restore({
        workflows: [{
            workflowId: 'workflow-a',
            name: 'replacement',
            data: { workflowId: 'workflow-a' }
        }],
        activeWorkflowId: 'workflow-a',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    closeGate.resolve({ ok: true });

    await assert.rejects(() => closing, { name: 'WorkflowHandleClosedError' });
    assert.deepEqual(desk.snapshot().open.map(({ workflowId, label }) => ({ workflowId, label })), [
        { workflowId: 'workflow-a', label: 'replacement' }
    ]);
});

test('identity-bound reload retains Workflow identity and commits through activation recovery', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async ({ kind }) => ({
            ok: true,
            selection: kind === 'reload' ? {
                label: 'reloaded',
                editorView: { async commit() { return true; } }
            } : null
        })
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'a',
        editorView: { async commit() { return true; } }
    });

    const result = await desk.workflow('workflow-a').reload();

    assert.equal(result.status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'workflow-a');
    assert.equal(desk.snapshot().active.label, 'reloaded');
});

test('closing the active Workflow commits fallback or safe-empty in the same handle operation', async () => {
    let useFallback = true;
    let safeEmptyCommits = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        commitSafeEmpty: async () => { safeEmptyCommits += 1; },
        mutateWorkflow: async ({ kind }) => ({
            ok: true,
            fallback: kind === 'close' && useFallback ? {
                workflowId: 'workflow-b',
                label: 'b',
                editorView: { async commit() { return true; } }
            } : null
        })
    });
    await desk.restore({
        workflows: [
            { name: 'a', workflowId: 'workflow-a', data: { workflowId: 'workflow-a' } },
            { name: 'b', workflowId: 'workflow-b', data: { workflowId: 'workflow-b' } }
        ],
        activeWorkflowId: 'workflow-a',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    const closedA = desk.workflow('workflow-a');

    assert.equal((await closedA.close()).status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'workflow-b');
    await assert.rejects(() => closedA.save(), { name: 'WorkflowHandleClosedError' });

    useFallback = false;
    assert.equal((await desk.workflow('workflow-b').close()).status, 'committed');
    assert.equal(desk.snapshot().active, null);
    assert.equal(safeEmptyCommits, 1);
});

test('production-style close publishes fallback and removal in one Desk revision', async () => {
    let desk;
    desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async ({ kind, closeToken }) => {
            if (kind !== 'close') return { ok: false };
            const result = await desk.show({
                workflowId: 'workflow-b',
                label: 'b',
                force: true,
                closeToken,
                editorView: { async commit() { return true; } }
            });
            return { ok: result.status === 'committed', handled: true };
        }
    });
    await desk.restore({
        workflows: [
            { name: 'a', workflowId: 'workflow-a', data: { workflowId: 'workflow-a' } },
            { name: 'b', workflowId: 'workflow-b', data: { workflowId: 'workflow-b' } }
        ],
        activeWorkflowId: 'workflow-a',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    const previousRevision = desk.snapshot().revision;

    assert.equal((await desk.workflow('workflow-a').close()).status, 'committed');
    assert.equal(desk.snapshot().revision, previousRevision + 1);
    assert.equal(desk.snapshot().active.workflowId, 'workflow-b');
    assert.deepEqual(desk.snapshot().open.map(({ workflowId }) => workflowId), ['workflow-b']);
});

test('unrelated activation cannot consume a pending close token', async () => {
    const closeGate = deferred();
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        mutateWorkflow: async ({ kind }) => kind === 'close'
            ? closeGate.promise
            : { ok: true }
    });
    await desk.restore({
        workflows: [{ name: 'a', workflowId: 'workflow-a', data: { workflowId: 'workflow-a' } }],
        activeWorkflowId: 'workflow-a',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    const closing = desk.workflow('workflow-a').close();
    await Promise.resolve();

    await desk.show({
        workflowId: 'workflow-c',
        label: 'c',
        editorView: { async commit() { return true; } }
    });
    closeGate.resolve({ ok: false });

    assert.equal(await closing, false);
    assert.deepEqual(desk.snapshot().open.map(({ workflowId }) => workflowId), ['workflow-a', 'workflow-c']);
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

    preparations.get('workflow-a')?.();
    preparations.get('workflow-b')?.();
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

test('an externally superseded request rolls back before publishing its committed snapshot', async () => {
    let current = true;
    let releaseCommit;
    let commitStarted;
    const started = new Promise((resolve) => { commitStarted = resolve; });
    const visible = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async ({ workflowId }) => ({
            async commit() {
                visible.push(`commit:${workflowId}`);
                commitStarted();
                await new Promise((resolve) => { releaseCommit = resolve; });
                return true;
            },
            rollback() { visible.push(`rollback:${workflowId}`); return true; }
        })
    });

    const pending = desk.show({
        workflowId: 'workflow-a',
        label: 'A',
        isCurrent: () => current
    });
    await started;
    current = false;
    releaseCommit();

    assert.equal((await pending).status, 'superseded');
    assert.equal(desk.snapshot().active, null);
    assert.deepEqual(visible, ['commit:workflow-a', 'rollback:workflow-a']);
});

test('restore prefers saved document Workflow identity over stale session identity', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'generated-id'
    });

    const result = await desk.restore({
        workflows: [{
            name: 'folder/A',
            workflowId: 'stale-session-id',
            data: { workflowId: 'saved-document-id' }
        }],
        activeWorkflowId: 'stale-session-id',
        activeWorkflowName: 'folder/A',
        prepareEditorView: async () => ({
            async commit() { return true; },
            finalize() { return true; }
        })
    });

    assert.equal(result.status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'saved-document-id');
    assert.equal(result.workflows[0].workflowId, 'saved-document-id');
});

test('restore lazily assigns missing Workflow identity without writing the document', async () => {
    let documentWrites = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'generated-id',
        saveWorkflowDocument: async () => { documentWrites += 1; }
    });
    const workflow = { name: 'legacy', data: {} };

    const result = await desk.restore({
        workflows: [workflow],
        activeWorkflowName: 'legacy',
        prepareEditorView: async () => ({
            async commit() { return true; },
            finalize() { return true; }
        })
    });

    assert.equal(result.migrations[0].kind, 'missing-identity');
    assert.equal(result.workflows[0].workflowId, 'generated-id');
    assert.equal(result.workflows[0].data.workflowId, 'generated-id');
    assert.equal(workflow.workflowId, undefined);
    assert.equal(desk.snapshot().open[0].pendingExplicitSave, true);
    assert.equal(documentWrites, 0);

    desk.workflow('generated-id').documentSaved();
    assert.equal(desk.snapshot().open[0].pendingExplicitSave, false);
});

test('restore atomically replaces the open Workflow identity index', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView
    });
    const prepareEditorView = async () => ({
        async commit() { return true; },
        finalize() { return true; }
    });

    await desk.restore({
        workflows: [{ name: 'A', workflowId: 'workflow-a', data: { workflowId: 'workflow-a' } }],
        activeWorkflowId: 'workflow-a',
        prepareEditorView
    });
    await desk.restore({
        workflows: [{ name: 'B', workflowId: 'workflow-b', data: { workflowId: 'workflow-b' } }],
        activeWorkflowId: 'workflow-b',
        prepareEditorView
    });

    assert.deepEqual(desk.snapshot().open.map(({ workflowId }) => workflowId), ['workflow-b']);
});

test('failed restore preserves the committed open Workflow identity index', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView
    });
    await desk.restore({
        workflows: [{ name: 'A', workflowId: 'workflow-a', data: { workflowId: 'workflow-a' } }],
        activeWorkflowId: 'workflow-a',
        prepareEditorView: async () => ({
            async commit() { return true; },
            rollback() { return true; },
            finalize() { return true; }
        })
    });

    await assert.rejects(() => desk.restore({
        workflows: [{ name: 'B', workflowId: 'workflow-b', data: { workflowId: 'workflow-b' } }],
        activeWorkflowId: 'workflow-b',
        prepareEditorView: async () => ({
            async commit() { throw new Error('cannot show B'); },
            rollback() { return true; }
        })
    }), WorkflowEditorCommitError);

    assert.deepEqual(desk.snapshot().open.map(({ workflowId }) => workflowId), ['workflow-a']);
});

test('restore retains pending explicit save until the Workflow document is explicitly saved', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView
    });

    const result = await desk.restore({
        workflows: [{
            name: 'legacy',
            workflowId: 'migrated-id',
            identityPendingSave: true,
            data: { workflowId: 'migrated-id' }
        }],
        activeWorkflowId: 'migrated-id',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });

    assert.equal(result.workflows[0].identityPendingSave, true);
    assert.equal(desk.snapshot().open[0].pendingExplicitSave, true);
});

test('restore reconciles stale session identity to saved document identity without name fallback', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView
    });

    await desk.restore({
        workflows: [{
            name: 'renamed-after-session',
            workflowId: 'stale-session-id',
            data: { workflowId: 'saved-document-id' }
        }],
        activeWorkflowId: 'stale-session-id',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });

    assert.equal(desk.snapshot().active.workflowId, 'saved-document-id');
});

test('empty restoration that reaches its commit point publishes atomically before a newer activation', async () => {
    const emptyCommit = deferred();
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        commitSafeEmpty: async () => emptyCommit.promise
    });
    const restoringEmpty = desk.restore({ workflows: [] });
    await Promise.resolve();
    const showingNewer = desk.show({
        workflowId: 'workflow-new',
        label: 'new',
        editorView: { async commit() { return true; } }
    });

    emptyCommit.resolve();
    assert.equal((await restoringEmpty).status, 'committed');
    assert.equal((await showingNewer).status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'workflow-new');
});

test('restore retains the first duplicate Workflow identity and repairs the later external copy', async () => {
    const diagnostics = [];
    const ids = ['repaired-id'];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => ids.shift(),
        recordDiagnostic: async (record) => diagnostics.push(record)
    });

    const result = await desk.restore({
        workflows: [
            { name: 'first', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } },
            { name: 'copy', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } }
        ],
        activeWorkflowId: 'duplicate-id',
        activeWorkflowName: 'copy',
        prepareEditorView: async () => ({ async commit() { return true; } })
    });

    assert.equal(result.workflows[0].workflowId, 'duplicate-id');
    assert.equal(result.workflows[1].workflowId, 'repaired-id');
    assert.equal(result.workflows[1].identityPendingSave, true);
    assert.equal(desk.snapshot().active.workflowId, 'repaired-id');
    assert.equal(diagnostics[0].kind, 'workflow-duplicate-identity-repaired');
});

test('ambiguous duplicate ownership stops restore without changing committed state', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'repaired-id'
    });

    const result = await desk.restore({
        workflows: [
            { name: 'same', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } },
            { name: 'same', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } }
        ],
        activeWorkflowId: 'duplicate-id',
        activeWorkflowName: 'same'
    });

    assert.equal(result.status, 'identity-ownership-failed');
    assert.equal(result.failure.kind, 'ambiguous-workflow-identity');
    assert.equal(desk.snapshot().active, null);
    assert.deepEqual(desk.snapshot().open, []);
});

test('duplicate active identity without a migration label is ambiguous', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'repaired-id'
    });
    const result = await desk.restore({
        workflows: [
            { name: 'first', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } },
            { name: 'copy', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id' } }
        ],
        activeWorkflowId: 'duplicate-id'
    });
    assert.equal(result.status, 'identity-ownership-failed');
    assert.equal(desk.snapshot().active, null);
});

test('ordinary discovery repairs an external copy and ambiguous ownership fails explicitly', async () => {
    const diagnostics = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'copy-id',
        recordDiagnostic: async (record) => diagnostics.push(record)
    });
    await desk.show({
        workflowId: 'original-id',
        label: 'original',
        editorView: { async commit() { return true; } }
    });
    const copy = { workflowId: 'original-id', data: { workflowId: 'original-id' } };
    await desk.show({
        workflowId: 'original-id',
        label: 'copy',
        identityOwnership: 'external-copy',
        identityRepair: {
            commit: ({ workflowId }) => {
                copy.workflowId = workflowId;
                copy.data.workflowId = workflowId;
                copy.identityPendingSave = true;
            },
            rollback: () => {
                copy.workflowId = 'original-id';
                copy.data.workflowId = 'original-id';
                copy.identityPendingSave = false;
            }
        },
        editorView: { async commit() { return true; } }
    });

    assert.equal(desk.snapshot().active.workflowId, 'copy-id');
    assert.equal(copy.workflowId, 'copy-id');
    assert.equal(copy.data.workflowId, 'copy-id');
    assert.equal(copy.identityPendingSave, true);
    assert.equal(desk.snapshot().open[1].pendingExplicitSave, true);
    assert.equal(diagnostics[0].kind, 'workflow-duplicate-identity-repaired');
    await assert.rejects(() => desk.show({
        workflowId: 'original-id',
        identityOwnership: 'ambiguous'
    }), WorkflowIdentityOwnershipError);
    assert.equal(desk.snapshot().active.workflowId, 'copy-id');
});

test('duplicate diagnostic failure does not reverse repair or activation', async () => {
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'copy-id',
        recordDiagnostic: async () => { throw new Error('diagnostics unavailable'); }
    });
    await desk.show({
        workflowId: 'original-id',
        label: 'original',
        editorView: { async commit() { return true; } }
    });

    const result = await desk.show({
        workflowId: 'original-id',
        label: 'copy',
        identityOwnership: 'external-copy',
        editorView: { async commit() { return true; } }
    });

    assert.equal(result.status, 'committed');
    assert.equal(desk.snapshot().active.workflowId, 'copy-id');
});

test('failed duplicate activation does not record a completed repair', async () => {
    const diagnostics = [];
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'copy-id',
        recordDiagnostic: async (record) => diagnostics.push(record)
    });
    await desk.show({
        workflowId: 'original-id',
        label: 'original',
        editorView: { async commit() { return true; } }
    });

    await assert.rejects(() => desk.show({
        workflowId: 'original-id',
        label: 'copy',
        identityOwnership: 'external-copy',
        editorView: {
            async commit() { return false; },
            rollback() { return true; }
        }
    }), WorkflowEditorCommitError);

    assert.deepEqual(diagnostics, []);
    assert.equal(desk.snapshot().active.workflowId, 'original-id');
});

test('failed identity repair rollback enters explicit safe-empty recovery', async () => {
    const diagnostics = [];
    let safeEmptyCommits = 0;
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'copy-id',
        commitSafeEmpty: async () => { safeEmptyCommits += 1; },
        recordDiagnostic: async (record) => diagnostics.push(record)
    });
    await desk.show({
        workflowId: 'original-id',
        label: 'original',
        editorView: { async commit() { return true; } }
    });

    await assert.rejects(() => desk.show({
        workflowId: 'original-id',
        label: 'copy',
        identityOwnership: 'external-copy',
        identityRepair: {
            commit() { throw new Error('repair failed'); },
            rollback() { throw new Error('rollback failed'); }
        },
        editorView: { async commit() { return true; } }
    }), WorkflowCommitRecoveryError);

    assert.equal(safeEmptyCommits, 1);
    assert.equal(desk.snapshot().active, null);
    assert.equal(diagnostics[0].kind, 'workflow-identity-repair-rollback-failed');
});
