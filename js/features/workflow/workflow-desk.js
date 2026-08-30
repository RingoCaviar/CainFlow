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

export class WorkflowIdentityOwnershipError extends Error {
    constructor(message = 'Workflow identity ownership is ambiguous', options = {}) {
        super(message, options);
        this.name = 'WorkflowIdentityOwnershipError';
        this.workflowId = options.workflowId || '';
    }
}

export class WorkflowHandleClosedError extends Error {
    constructor(message = 'Workflow handle no longer refers to an open Workflow', options = {}) {
        super(message, options);
        this.name = 'WorkflowHandleClosedError';
        this.workflowId = options.workflowId || '';
    }
}

export class WorkflowRunningPolicyError extends Error {
    constructor(message = 'Running Workflow cannot perform this mutation', options = {}) {
        super(message, options);
        this.name = 'WorkflowRunningPolicyError';
        this.workflowId = options.workflowId || '';
        this.operation = options.operation || '';
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
    recordDiagnostic = async () => {},
    mutateWorkflow = async () => ({ ok: false }),
    createWorkflowId = () => globalThis.crypto?.randomUUID?.()
        || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`
}) {
    const openWorkflows = new Map();
    const pendingCloseTokens = new Map();
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

    async function rollbackIdentityRepair(target, cause) {
        try {
            await target.identityRepair?.rollback?.();
            return;
        } catch (error) {
            try {
                await recordDiagnostic({
                    kind: 'workflow-identity-repair-rollback-failed',
                    workflowId: target.workflowId,
                    duplicatedWorkflowId: target.duplicatedWorkflowId,
                    revision,
                    error
                });
            } catch {}
            await publishSafeEmpty(target, cause || error);
        }
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
        let identityRepaired = false;
        try {
            if (target.identityRepair) {
                await target.identityRepair.commit({
                workflowId: target.workflowId,
                duplicatedWorkflowId: target.duplicatedWorkflowId
                });
                identityRepaired = true;
            }
        } catch (error) {
            await rollbackIdentityRepair(target, error);
            await rollbackPreparedView(editorView, target, error);
            throw new WorkflowIdentityOwnershipError('Repaired Workflow identity could not be committed', {
                cause: error,
                workflowId: target.workflowId
            });
        }
        if (!isTargetCurrent(target, generation)) {
            if (identityRepaired) {
                await rollbackIdentityRepair(target, null);
            }
            await rollbackPreparedView(editorView, target, null);
            return Object.freeze({ status: 'superseded', snapshot: currentSnapshot });
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
        const closingWorkflowId = pendingCloseTokens.get(target.closeToken);
        if (closingWorkflowId) openWorkflows.delete(closingWorkflowId);
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
        if (target.duplicateDiagnostic) {
            try { await recordDiagnostic(target.duplicateDiagnostic); } catch {}
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

    function setMigratedWorkflowRunning(workflowId, running) {
        const current = openWorkflows.get(workflowId);
        if (!current) return false;
        openWorkflows.set(workflowId, { ...current, running: running === true });
        revision += 1;
        publishSnapshot();
        return true;
    }

    function requireOpenWorkflow(workflowId) {
        const current = openWorkflows.get(workflowId);
        if (!current) throw new WorkflowHandleClosedError(undefined, { workflowId });
        return current;
    }

    function requireMutationAllowed(workflowId, kind) {
        const current = requireOpenWorkflow(workflowId);
        if (current.running === true && ['rename', 'move', 'reload', 'close'].includes(kind)) {
            throw new WorkflowRunningPolicyError(undefined, { workflowId, operation: kind });
        }
        return current;
    }

    function publishRelabel(workflowId, label) {
        const current = requireOpenWorkflow(workflowId);
        openWorkflows.set(workflowId, { ...current, label });
        revision += 1;
        if (active?.workflowId === workflowId) {
            active = Object.freeze({ ...active, label, revision });
        }
        publishSnapshot();
    }

    function allocateWorkflowId() {
        let workflowId = createWorkflowId();
        while (!workflowId || openWorkflows.has(workflowId)) workflowId = createWorkflowId();
        return workflowId;
    }

    async function runIdentityMutation(workflowId, kind, options = {}) {
        const current = requireMutationAllowed(workflowId, kind);
        const closeToken = kind === 'close' ? Object.freeze({ workflowId }) : null;
        if (closeToken) pendingCloseTokens.set(closeToken, workflowId);
        let result;
        try {
            result = await mutateWorkflow(Object.freeze({
                kind,
                workflowId,
                label: current.label,
                closeToken,
                ...options
            }));
        } finally {
            if (closeToken) pendingCloseTokens.delete(closeToken);
        }
        if (result?.ok !== true) return false;
        if (kind === 'save') markMigratedWorkflowSaved(workflowId);
        if ((kind === 'rename' || kind === 'move') && options.label) {
            publishRelabel(workflowId, options.label);
        }
        if ((kind === 'copy' || kind === 'save-as') && options.registerOpen !== false) {
            openWorkflows.set(options.newWorkflowId, {
                workflowId: options.newWorkflowId,
                label: options.label || current.label,
                pendingExplicitSave: false,
                running: false
            });
            revision += 1;
            publishSnapshot();
            return workflow(options.newWorkflowId);
        }
        if (kind === 'copy' || kind === 'save-as') {
            return Object.freeze({ status: 'committed', workflowId: options.newWorkflowId, snapshot: currentSnapshot });
        }
        if (kind === 'reload' && result.selection) {
            return show({ ...result.selection, workflowId, force: true });
        }
        if (kind === 'reload' && result.handled === true) {
            return Object.freeze({ status: 'committed', workflowId, snapshot: currentSnapshot });
        }
        if (kind === 'close') {
            if (!openWorkflows.has(workflowId)) {
                return Object.freeze({ status: 'committed', workflowId, snapshot: currentSnapshot });
            }
            const candidate = new Map(openWorkflows);
            candidate.delete(workflowId);
            if (active?.workflowId === workflowId) {
                if (result.fallback) {
                    return show({ ...result.fallback, restoredOpenWorkflows: candidate, force: true });
                }
                return commitRestoredEmpty({ restoredOpenWorkflows: candidate });
            }
            openWorkflows.delete(workflowId);
            revision += 1;
            publishSnapshot();
        }
        return Object.freeze({ status: 'committed', workflowId, snapshot: currentSnapshot });
    }

    function workflow(workflowId) {
        const identity = String(workflowId || '').trim();
        return Object.freeze({
            workflowId: identity,
            save: () => runIdentityMutation(identity, 'save'),
            rename: (label) => runIdentityMutation(identity, 'rename', { label }),
            move: (label) => runIdentityMutation(identity, 'move', { label }),
            reload: () => runIdentityMutation(identity, 'reload'),
            close: () => runIdentityMutation(identity, 'close'),
            copy: (label, mutationOptions = {}) => runIdentityMutation(identity, 'copy', {
                label,
                ...mutationOptions,
                newWorkflowId: allocateWorkflowId()
            }),
            saveAs: (label, mutationOptions = {}) => runIdentityMutation(identity, 'save-as', {
                label,
                ...mutationOptions,
                newWorkflowId: allocateWorkflowId()
            })
        });
    }

    function normalizeRestoredWorkflows(workflows) {
        const seen = new Set();
        const migrations = [];
        const identityAliases = new Map();
        const duplicateOwners = new Map();
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
            const duplicatedIdentity = !!workflowId && seen.has(workflowId);
            const duplicatedWorkflowId = duplicatedIdentity ? workflowId : '';
            if (!workflowId || duplicatedIdentity) workflowId = createWorkflowId();
            while (!workflowId || seen.has(workflowId)) workflowId = createWorkflowId();
            workflow.workflowId = workflowId;
            if (workflow.data && typeof workflow.data === 'object') workflow.data.workflowId = workflowId;
            workflow.identityPendingSave = missingIdentity
                || duplicatedIdentity
                || workflow.identityPendingSave === true;
            if (missingIdentity) {
                migrations.push(Object.freeze({
                    kind: 'missing-identity',
                    workflowId,
                    label: workflow.name || ''
                }));
            } else if (duplicatedIdentity) {
                migrations.push(Object.freeze({
                    kind: 'duplicate-identity',
                    duplicatedWorkflowId,
                    workflowId,
                    label: workflow.name || ''
                }));
            }
            seen.add(workflowId);
            if (sessionId && !identityAliases.has(sessionId)) identityAliases.set(sessionId, workflowId);
            if (sessionId) {
                const owners = duplicateOwners.get(sessionId) || [];
                owners.push(workflow);
                duplicateOwners.set(sessionId, owners);
            }
            restoredOpenWorkflows.set(workflowId, {
                workflowId,
                label: workflow.name || '',
                pendingExplicitSave: workflow.identityPendingSave,
                running: workflow.running === true
            });
            normalizedWorkflows.push(workflow);
        }
        return { normalizedWorkflows, migrations, identityAliases, duplicateOwners, restoredOpenWorkflows };
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
                let recovered = false;
                try {
                    recovered = typeof active?.editorView?.commit === 'function'
                        && await active.editorView.commit() !== false;
                } catch {}
                if (recovered) {
                    throw new WorkflowEditorCommitError('Empty Workflow editor view commit failed', { cause: error });
                }
                active = null;
                revision += 1;
                publishSnapshot();
                throw new WorkflowCommitRecoveryError(undefined, { cause: error });
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
            duplicateOwners,
            restoredOpenWorkflows
        } = normalizeRestoredWorkflows(sourceWorkflows);
        const duplicatedActiveOwners = duplicateOwners.get(restoration.activeWorkflowId) || [];
        if (duplicatedActiveOwners.length > 1) {
            const namedOwners = restoration.activeWorkflowName
                ? duplicatedActiveOwners.filter((workflow) => (
                    workflow.name === restoration.activeWorkflowName
                ))
                : [];
            if (namedOwners.length !== 1) {
                return Object.freeze({
                    status: 'identity-ownership-failed',
                    failure: Object.freeze({
                        kind: 'ambiguous-workflow-identity',
                        workflowId: restoration.activeWorkflowId
                    }),
                    workflows: sourceWorkflows,
                    migrations: Object.freeze([]),
                    snapshot: currentSnapshot
                });
            }
            identityAliases.set(restoration.activeWorkflowId, namedOwners[0].workflowId);
        }
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
            if (result.status === 'committed') await recordDuplicateMigrations(migrations);
            return Object.freeze({
                ...result,
                workflows,
                migrations: Object.freeze(migrations)
            });
        }
        const editorView = await restoration.prepareEditorView?.({
            workflowId: activeWorkflow.workflowId,
            label: activeWorkflow.name || '',
            document: restoration.activeDocument || activeWorkflow.data
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
        if (result.status === 'committed' || result.status === 'already-visible') {
            await recordDuplicateMigrations(migrations);
        }
        return Object.freeze({
            ...result,
            workflows,
            migrations: Object.freeze(migrations)
        });
    }

    async function recordDuplicateMigrations(migrations) {
        for (const migration of migrations) {
            if (migration.kind !== 'duplicate-identity') continue;
            try {
                await recordDiagnostic({
                    kind: 'workflow-duplicate-identity-repaired',
                    duplicatedWorkflowId: migration.duplicatedWorkflowId,
                    workflowId: migration.workflowId,
                    label: migration.label
                });
            } catch {}
        }
    }

    async function show(selection) {
        const generation = ++activationGeneration;
        let target = await resolveSelection(selection);
        if (target?.identityOwnership === 'ambiguous') {
            throw new WorkflowIdentityOwnershipError(undefined, { workflowId: target.workflowId });
        }
        if (target?.identityOwnership === 'external-copy' && openWorkflows.has(target.workflowId)) {
            const duplicatedWorkflowId = target.workflowId;
            let workflowId = createWorkflowId();
            while (!workflowId || openWorkflows.has(workflowId)) workflowId = createWorkflowId();
            target = {
                ...target,
                workflowId,
                duplicatedWorkflowId,
                pendingExplicitSave: true,
                duplicateDiagnostic: {
                    kind: 'workflow-duplicate-identity-repaired',
                    duplicatedWorkflowId,
                    workflowId,
                    label: target.label || ''
                }
            };
        }
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

    const documentState = Object.freeze({
        commitActive: commitMigratedActiveState,
        relabelActive: relabelMigratedActiveState,
        clearActive: clearMigratedActiveState,
        markSaved: markMigratedWorkflowSaved,
        setRunning: setMigratedWorkflowRunning
    });
    return Object.freeze({ show, restore, workflow, snapshot: () => currentSnapshot, documentState });
}
