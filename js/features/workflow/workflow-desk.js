function freezeOpenWorkflow(record) {
    return Object.freeze({
        workflowId: record.workflowId,
        label: record.label,
        pendingExplicitSave: record.pendingExplicitSave === true,
        running: record.running === true
    });
}

export class WorkflowEditorCommitError extends Error {
    constructor(message = 'Workflow editor view commit failed', options = {}) {
        super(message, options);
        this.name = 'WorkflowEditorCommitError';
    }
}

export class WorkflowCommitRecoveryError extends Error {
    constructor(message = 'Workflow activation could not restore the previous editor view', options = {}) {
        super(message, options);
        this.name = 'WorkflowCommitRecoveryError';
    }
}

export class WorkflowEditorPrepareError extends Error {
    constructor(message = 'Workflow editor view preparation failed', options = {}) {
        super(message, options);
        this.name = 'WorkflowEditorPrepareError';
    }
}

function freezeSnapshot({ revision, active, openWorkflows }) {
    return Object.freeze({
        revision,
        active,
        open: Object.freeze(Array.from(openWorkflows.values(), freezeOpenWorkflow))
    });
}

export function attachWorkflowDeskStateProjection(state, workflowDesk) {
    const readActive = () => workflowDesk.snapshot().active;
    const rejectWrite = () => {
        throw new TypeError('Active workflow state is a read-only WorkflowDesk projection');
    };
    Object.defineProperties(state, {
        activeWorkflowId: {
            configurable: true,
            enumerable: true,
            get: () => readActive()?.workflowId || '',
            set: rejectWrite
        },
        activeWorkflowName: {
            configurable: true,
            enumerable: true,
            get: () => readActive()?.label || '',
            set: rejectWrite
        }
    });
    return state;
}

export function createWorkflowDesk({
    resolveSelection,
    prepareEditorView,
    commitSafeEmpty = async () => {},
    recordDiagnostic = async () => {}
}) {
    const openWorkflows = new Map();
    let revision = 0;
    let activationGeneration = 0;
    let active = null;
    let commitLane = Promise.resolve();
    let currentSnapshot = freezeSnapshot({ revision, active, openWorkflows });

    function publishSnapshot() {
        currentSnapshot = freezeSnapshot({ revision, active, openWorkflows });
        return currentSnapshot;
    }

    async function publishSafeEmpty(target, cause) {
        try {
            await commitSafeEmpty();
        } catch (error) {
            try {
                await recordDiagnostic({
                    kind: 'workflow-safe-empty-commit-failed',
                    workflowId: target.workflowId,
                    revision,
                    error
                });
            } catch {}
            throw new WorkflowCommitRecoveryError(undefined, { cause: error });
        }
        revision += 1;
        active = null;
        publishSnapshot();
        try {
            await recordDiagnostic({
                kind: 'workflow-commit-recovery-failed',
                workflowId: target.workflowId,
                revision,
                error: cause
            });
        } catch {}
        throw new WorkflowCommitRecoveryError(undefined, { cause });
    }

    async function rollbackPreparedView(editorView, target, cause) {
        let recovered = false;
        try {
            recovered = editorView.rollback?.() === true;
        } catch {}
        if (!recovered) await publishSafeEmpty(target, cause);
    }

    function isTargetCurrent(target, generation) {
        return generation === activationGeneration
            && target?.signal?.aborted !== true
            && target?.isCurrent?.() !== false;
    }

    async function commitPreparedTarget({ generation, target, editorView }) {
        if (!isTargetCurrent(target, generation)) {
            editorView.dispose?.();
            return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
        }
        let committed = false;
        let commitError = null;
        try {
            committed = await editorView.commit();
        } catch (error) {
            commitError = error;
        }
        if (!isTargetCurrent(target, generation)) {
            await rollbackPreparedView(editorView, target, commitError);
            return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
        }
        if (committed === false) {
            await rollbackPreparedView(editorView, target, commitError);
            throw new WorkflowEditorCommitError(undefined, { cause: commitError });
        }
        revision += 1;
        openWorkflows.set(target.workflowId, {
            workflowId: target.workflowId,
            label: target.label,
            pendingExplicitSave: false,
            running: false
        });
        active = Object.freeze({
            workflowId: target.workflowId,
            label: target.label,
            editorView,
            revision
        });
        publishSnapshot();
        try {
            await editorView.finalize?.();
        } catch (error) {
            try {
                await recordDiagnostic({
                    kind: 'workflow-activation-finalize-failed',
                    workflowId: target.workflowId,
                    revision,
                    error
                });
            } catch {}
        }
        return Object.freeze({ status: 'committed', active, snapshot: currentSnapshot });
    }

    function enqueueCommit(operation) {
        const result = commitLane.then(operation, operation);
        commitLane = result.then(() => undefined, () => undefined);
        return result;
    }

    function commitMigratedActiveState({ workflowId, label, editorView = null }) {
        if (!workflowId || !label) throw new TypeError('Committed Workflow identity and label are required');
        revision += 1;
        const current = openWorkflows.get(workflowId) || {};
        openWorkflows.set(workflowId, {
            ...current,
            workflowId,
            label,
            pendingExplicitSave: current.pendingExplicitSave === true,
            running: current.running === true
        });
        active = Object.freeze({ workflowId, label, editorView, revision });
        publishSnapshot();
        return currentSnapshot;
    }

    function relabelMigratedActiveState(workflowId, label) {
        if (!workflowId || active?.workflowId !== workflowId) return false;
        return !!commitMigratedActiveState({ workflowId, label, editorView: active.editorView });
    }

    function clearMigratedActiveState() {
        revision += 1;
        active = null;
        publishSnapshot();
        return currentSnapshot;
    }

    async function show(selection) {
        const generation = ++activationGeneration;
        const target = await resolveSelection(selection);
        if (!isTargetCurrent(target, generation)) {
            target.editorView?.dispose?.();
            return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
        }
        if (active?.workflowId === target.workflowId && target.force !== true) {
            target.editorView?.dispose?.();
            return Object.freeze({ status: 'already-visible', active, snapshot: currentSnapshot });
        }
        let editorView;
        try {
            editorView = await prepareEditorView(target);
        } catch (error) {
            if (!isTargetCurrent(target, generation)) {
                return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
            }
            throw new WorkflowEditorPrepareError(undefined, { cause: error });
        }
        return enqueueCommit(() => commitPreparedTarget({ generation, target, editorView }));
    }

    const migration = Object.freeze({
        commitActive: commitMigratedActiveState,
        relabelActive: relabelMigratedActiveState,
        clearActive: clearMigratedActiveState
    });
    return Object.freeze({ show, snapshot: () => currentSnapshot, migration });
}
