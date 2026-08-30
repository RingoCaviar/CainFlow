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
    let currentSnapshot = freezeSnapshot({ revision, active, openWorkflows });

    function publishSnapshot() {
        currentSnapshot = freezeSnapshot({ revision, active, openWorkflows });
        return currentSnapshot;
    }

    async function show(selection) {
        const generation = ++activationGeneration;
        const target = await resolveSelection(selection);
        if (active?.workflowId === target.workflowId) {
            return Object.freeze({ status: 'already-visible', active, snapshot: currentSnapshot });
        }
        let editorView;
        try {
            editorView = await prepareEditorView(target);
        } catch (error) {
            throw new WorkflowEditorPrepareError(undefined, { cause: error });
        }
        if (generation !== activationGeneration) {
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
        if (generation !== activationGeneration) {
            editorView.rollback?.();
            return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
        }
        if (committed === false) {
            let recovered = false;
            try {
                recovered = editorView.rollback?.() === true;
            } catch {}
            if (!recovered) {
                await commitSafeEmpty();
                revision += 1;
                active = null;
                publishSnapshot();
                try {
                    await recordDiagnostic({
                        kind: 'workflow-commit-recovery-failed',
                        workflowId: target.workflowId,
                        revision
                    });
                } catch {}
                throw new WorkflowCommitRecoveryError(undefined, { cause: commitError });
            }
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

    return Object.freeze({ show, snapshot: () => currentSnapshot });
}
