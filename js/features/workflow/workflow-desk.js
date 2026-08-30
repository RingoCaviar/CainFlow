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
    recordDiagnostic = async () => {},
    createWorkflowId = () => globalThis.crypto?.randomUUID?.()
        || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`
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
        if (target.restoredOpenWorkflows instanceof Map) {
            openWorkflows.clear();
            for (const [workflowId, workflow] of target.restoredOpenWorkflows) {
                openWorkflows.set(workflowId, workflow);
            }
        } else {
            openWorkflows.set(target.workflowId, {
                workflowId: target.workflowId,
                label: target.label,
                pendingExplicitSave: target.pendingExplicitSave === true,
                running: false
            });
        }
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

    function markMigratedWorkflowSaved(workflowId) {
        const current = openWorkflows.get(workflowId);
        if (!current || current.pendingExplicitSave !== true) return false;
        openWorkflows.set(workflowId, { ...current, pendingExplicitSave: false });
        publishSnapshot();
        return true;
    }

    function normalizeRestoredWorkflows(workflows) {
        const seen = new Set();
        const migrations = [];
        const identityAliases = new Map();
        const restoredOpenWorkflows = new Map();
        const normalizedWorkflows = [];
        for (const sourceWorkflow of workflows) {
            if (!sourceWorkflow || typeof sourceWorkflow !== 'object') continue;
            const workflow = {
                ...sourceWorkflow,
                data: sourceWorkflow.data && typeof sourceWorkflow.data === 'object'
                    ? { ...sourceWorkflow.data }
                    : sourceWorkflow.data
            };
            if (!workflow || typeof workflow !== 'object') continue;
            const savedDocumentId = String(workflow.data?.workflowId || '').trim();
            const sessionId = String(workflow.workflowId || '').trim();
            let workflowId = savedDocumentId || sessionId;
            const missingIdentity = !workflowId;
            if (!workflowId || seen.has(workflowId)) workflowId = createWorkflowId();
            while (!workflowId || seen.has(workflowId)) workflowId = createWorkflowId();
            workflow.workflowId = workflowId;
            if (workflow.data && typeof workflow.data === 'object') workflow.data.workflowId = workflowId;
            workflow.identityPendingSave = missingIdentity || workflow.identityPendingSave === true;
            if (missingIdentity) {
                migrations.push(Object.freeze({
                    kind: 'missing-identity',
                    workflowId,
                    label: workflow.name || ''
                }));
            }
            seen.add(workflowId);
            if (sessionId) identityAliases.set(sessionId, workflowId);
            restoredOpenWorkflows.set(workflowId, {
                workflowId,
                label: workflow.name || '',
                pendingExplicitSave: workflow.identityPendingSave,
                running: workflow.running === true
            });
            normalizedWorkflows.push(workflow);
        }
        return { normalizedWorkflows, migrations, identityAliases, restoredOpenWorkflows };
    }

    async function commitRestoredEmpty({ restoredOpenWorkflows, signal, isCurrent }) {
        const generation = ++activationGeneration;
        return enqueueCommit(async () => {
            if (generation !== activationGeneration || signal?.aborted === true || isCurrent?.() === false) {
                return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
            }
            try {
                await commitSafeEmpty();
            } catch (error) {
                throw new WorkflowEditorCommitError('Empty Workflow editor view commit failed', { cause: error });
            }
            if (generation !== activationGeneration || signal?.aborted === true || isCurrent?.() === false) {
                return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
            }
            openWorkflows.clear();
            for (const [workflowId, workflow] of restoredOpenWorkflows) {
                openWorkflows.set(workflowId, workflow);
            }
            active = null;
            revision += 1;
            publishSnapshot();
            return Object.freeze({ status: 'committed', snapshot: currentSnapshot });
        });
    }

    async function restore(restoration = {}) {
        const sourceWorkflows = Array.isArray(restoration.workflows) ? restoration.workflows : [];
        const {
            normalizedWorkflows: workflows,
            migrations,
            identityAliases,
            restoredOpenWorkflows
        } = normalizeRestoredWorkflows(sourceWorkflows);
        const restoredActiveWorkflowId = identityAliases.get(restoration.activeWorkflowId)
            || restoration.activeWorkflowId;
        let activeWorkflow = workflows.find((workflow) => (
            restoredActiveWorkflowId
            && workflow.workflowId === restoredActiveWorkflowId
        ));
        if (!activeWorkflow && restoration.activeWorkflowName) {
            activeWorkflow = workflows.find((workflow) => workflow.name === restoration.activeWorkflowName);
        }
        if (!activeWorkflow) {
            const result = await commitRestoredEmpty({
                restoredOpenWorkflows,
                signal: restoration.signal,
                isCurrent: restoration.isCurrent
            });
            return Object.freeze({
                ...result,
                workflows,
                migrations: Object.freeze(migrations)
            });
        }
        const editorView = await restoration.prepareEditorView?.({
            workflowId: activeWorkflow.workflowId,
            label: activeWorkflow.name || '',
            document: activeWorkflow.data
        });
        const result = await show({
            workflowId: activeWorkflow.workflowId,
            label: activeWorkflow.name || '',
            editorView,
            force: true,
            pendingExplicitSave: activeWorkflow.identityPendingSave === true,
            restoredOpenWorkflows,
            signal: restoration.signal,
            isCurrent: restoration.isCurrent
        });
        return Object.freeze({
            ...result,
            workflows,
            migrations: Object.freeze(migrations)
        });
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
        clearActive: clearMigratedActiveState,
        markSaved: markMigratedWorkflowSaved
    });
    return Object.freeze({ show, restore, snapshot: () => currentSnapshot, migration });
}
