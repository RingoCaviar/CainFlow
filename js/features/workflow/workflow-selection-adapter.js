import { migrateLegacyWorkflowData } from '../persistence/legacy-node-migration.js';
import { rollbackWorkflowActivation } from './workflow-rollback.js';
import {
    captureWorkflowTabRevision,
    replaceWorkflowTabData
} from './workflow-tab-revision.js';
import { WorkflowCommitRecoveryError } from './workflow-desk.js';

export function createWorkflowSessionSelectionAdapter({
    state,
    workflowDesk,
    createWorkflowId = () => globalThis.crypto?.randomUUID?.()
        || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`,
    prepareEditorView = null,
    applyViewport = () => {},
    onViewApplied = () => {}
}) {
    async function activateWithWorkflowDesk(restoredState) {
        const restoredTabs = Array.isArray(restoredState?.workflowTabs) ? restoredState.workflowTabs : [];
        const activeDocument = restoredState?.workflowData || null;
        const hasLegacyActiveDocument = restoredTabs.length === 0 && (
            restoredState?.activeWorkflowId
            || restoredState?.activeWorkflowName
            || activeDocument?.nodes?.length
            || activeDocument?.connections?.length
        );
        const legacyWorkflowId = hasLegacyActiveDocument
            ? (restoredState?.activeWorkflowId || createWorkflowId())
            : '';
        const workflowTabs = hasLegacyActiveDocument
            ? [{
                workflowId: legacyWorkflowId,
                name: restoredState?.activeWorkflowName || '',
                data: { ...activeDocument, workflowId: legacyWorkflowId },
                identityPendingSave: true
            }]
            : restoredTabs;
        const result = await workflowDesk.restore({
            workflows: workflowTabs,
            activeWorkflowId: legacyWorkflowId || restoredState?.activeWorkflowId || '',
            activeWorkflowName: restoredState?.activeWorkflowName || '',
            activeDocument,
            prepareEditorView: async ({ workflowId, label, document }) => {
                if (typeof prepareEditorView !== 'function') return null;
                return prepareEditorView(label, {
                    ...(document || {}),
                    workflowId
                });
            }
        });
        if (result.status !== 'committed' && result.status !== 'already-visible') return false;
        state.workflowTabs = result.workflows;
        state.workflowOrder = Array.isArray(restoredState?.workflowOrder) ? restoredState.workflowOrder : [];
        state.workflowFolders = Array.isArray(restoredState?.workflowFolders) ? restoredState.workflowFolders : [];
        const committed = workflowDesk.snapshot().active;
        applyViewport();
        onViewApplied({
            workflowName: committed?.label || '',
            workflowId: committed?.workflowId || ''
        });
        return true;
    }

    return { activate: activateWithWorkflowDesk };
}

export function createWorkflowSelectionAdapter({
    state,
    getActiveWorkflow = () => null,
    workflowDesk,
    getWorkflowTab,
    ensureWorkflowIdentity,
    loadWorkflowFromFile,
    prepareWorkflowView,
    prepareEditorView,
    snapshotActiveWorkflow,
    cloneWorkflowData,
    getEmptyWorkflowData,
    resolveWorkflowModelReferences,
    clearUndoStack,
    updatePortStyles,
    applyViewport,
    onViewApplied,
    onConnectionsChanged,
    scheduleAssetCleanup,
    showToast,
    renderWorkflowList,
    scheduleSave,
    releaseEditorView = () => false,
    releaseWorkflowTabMemory,
    enterSafeEmpty,
    tabColorCount = 6
}) {
    const isWorkflowRunning = (workflowId) => workflowDesk.snapshot().open
        .some((record) => record.workflowId === workflowId && record.running === true);
    async function activate(name, { reloadFromFile = false, closeToken = null } = {}) {
        if (!name) return false;
        const existingTab = getWorkflowTab(name);
        if (reloadFromFile && isWorkflowRunning(existingTab?.workflowId)) {
            showToast('工作流正在后台运行，暂不能从文件重载', 'warning');
            return false;
        }
        try {
            const result = await workflowDesk.show({
                async resolve() {
                let tab = getWorkflowTab(name);
                let createdTab = false;
                let reloadedData = null;
                if (!tab || reloadFromFile) {
                    const data = await loadWorkflowFromFile(name);
                    if (!data) return null;
                    reloadedData = migrateLegacyWorkflowData(data);
                    if (!tab) {
                        tab = {
                            name,
                            data: reloadedData,
                            dirty: false,
                            colorIndex: (state.workflowTabs || []).length % tabColorCount
                        };
                        ensureWorkflowIdentity(tab);
                        createdTab = true;
                    }
                } else {
                    ensureWorkflowIdentity(tab);
                }
                const stableWorkflowId = ensureWorkflowIdentity(tab);
                const identityOwners = (state.workflowTabs || []).filter((candidate) => (
                    candidate?.workflowId === stableWorkflowId || candidate?.data?.workflowId === stableWorkflowId
                ));
                const identityOwnership = createdTab && identityOwners.length === 1
                    ? 'external-copy'
                    : (createdTab && identityOwners.length > 1 ? 'ambiguous' : 'owned');
                if (!createdTab) {
                    tab = identityOwners.find((candidate) => candidate === tab) || tab;
                }
                const targetData = reloadedData || tab.data;
                const targetRevision = captureWorkflowTabRevision(tab, {
                    resolveTab: (workflowId) => (state.workflowTabs || [])
                        .find((candidate) => candidate.workflowId === workflowId) || null,
                    allowDetached: createdTab
                });
                const preparedView = await prepareWorkflowView(targetData, {
                    isCurrent: () => true
                });
                if (!preparedView) return null;
                if (typeof prepareEditorView !== 'function') {
                    throw new Error('Detached workflow editor preparation is unavailable');
                }
                if (reloadFromFile) {
                    releaseEditorView({ workflowName: tab.name, workflowId: stableWorkflowId });
                }
                const editorView = await prepareEditorView(name, {
                    ...preparedView.data,
                    nodes: preparedView.modelResolution.nodes
                });
                const prepared = { tab, createdTab, reloadedData, targetRevision, preparedView, editorView };
                const transactionalView = {
                    async commit() {
                        const currentTab = (state.workflowTabs || [])
                            .find((candidate) => candidate.workflowId === tab.workflowId) || tab;
                        if ((reloadedData && isWorkflowRunning(currentTab?.workflowId)) || !targetRevision.isCurrent()) return false;
                        snapshotActiveWorkflow();
                        const previousActiveName = getActiveWorkflow()?.label || '';
                        const previousActiveTab = getWorkflowTab(previousActiveName);
                        const previousData = previousActiveTab
                            ? cloneWorkflowData(previousActiveTab.data)
                            : getEmptyWorkflowData();
                        prepared.previous = {
                            name: previousActiveName,
                            workflowId: getActiveWorkflow()?.workflowId || ensureWorkflowIdentity(previousActiveTab),
                            tab: previousActiveTab,
                            data: previousData,
                            preparedView: {
                                data: previousData,
                                modelResolution: resolveWorkflowModelReferences(previousData, state)
                            },
                            undoStack: Array.isArray(state.undoStack) ? state.undoStack.slice() : []
                        };
                        if (reloadedData && !createdTab) {
                            prepared.previousTarget = {
                        data: cloneWorkflowData(tab.data),
                        dataRevision: tab.dataRevision,
                        dirty: tab.dirty === true,
                        runResult: tab.runResult || ''
                    };
                            reloadedData.workflowId = ensureWorkflowIdentity(tab);
                            replaceWorkflowTabData(tab, reloadedData);
                            tab.dirty = false;
                        }
                        if (createdTab && !getWorkflowTab(name)) state.workflowTabs.push(tab);
                        if (await editorView.commit?.() === false) return false;
                        if (prepared.previous.tab) prepared.previous.tab.data = cloneWorkflowData(prepared.previous.data);
                        clearUndoStack();
                        updatePortStyles();
                        applyViewport();
                        return true;
                    },
                    async rollback() {
                        const previous = prepared.previous;
                        if (!previous) {
                            editorView.dispose?.();
                            return true;
                        }
                        return rollbackWorkflowActivation({
                            prepared,
                            restorePrevious: async () => {
                                if (editorView.rollback?.() === false) return false;
                                state.undoStack = previous.undoStack;
                                updatePortStyles();
                                applyViewport();
                                onViewApplied({ workflowName: previous.name, workflowId: previous.workflowId });
                                return true;
                            },
                            cleanupCreatedTarget: (created) => {
                                state.workflowTabs = (state.workflowTabs || []).filter((item) => item !== created);
                                releaseWorkflowTabMemory(created);
                            },
                            restoreExistingTarget: (target, snapshot) => Object.assign(target, {
                                data: snapshot.data,
                                dataRevision: snapshot.dataRevision,
                                dirty: snapshot.dirty,
                                runResult: snapshot.runResult
                            }),
                            enterSafeEmpty,
                            reveal: () => {},
                            render: renderWorkflowList,
                            onRestoreError: (error) => console.error('Workflow activation rollback failed:', error)
                        });
                    },
                    finalize() {
                        editorView.finalize?.();
                        const active = getActiveWorkflow();
                        const effects = [
                            () => onViewApplied({ workflowName: active?.label || name, workflowId: active?.workflowId || '' }),
                            onConnectionsChanged,
                            () => scheduleAssetCleanup({ includeCanvas: true }),
                            () => showToast(`已打开工作流: ${active?.label || name}`, 'success'),
                            renderWorkflowList,
                            () => scheduleSave({ dirty: false })
                        ];
                        effects.forEach((effect) => { try { effect(); } catch (error) { console.warn('Workflow activation finalizer failed:', error); } });
                    },
                    dispose: () => editorView.dispose?.()
                };
                return {
                    workflowId: stableWorkflowId,
                    label: tab.name,
                    editorView: transactionalView,
                    identityOwnership,
                    identityRepair: identityOwnership === 'external-copy' ? (() => {
                                const previous = {
                                    workflowId: tab.workflowId,
                                    documentWorkflowId: tab.data?.workflowId
                                };
                                return {
                                    commit: ({ workflowId }) => {
                                        tab.workflowId = workflowId;
                                        if (tab.data && typeof tab.data === 'object') tab.data.workflowId = workflowId;
                                    },
                                    rollback: () => {
                                        tab.workflowId = previous.workflowId;
                                        if (tab.data && typeof tab.data === 'object') {
                                            tab.data.workflowId = previous.documentWorkflowId;
                                        }
                                    }
                                };
                    })() : null,
                    force: reloadFromFile,
                    closeToken
                };
            }
            });
            return result.status === 'committed' || result.status === 'already-visible';
        } catch (error) {
            if (!(error instanceof WorkflowCommitRecoveryError)) console.error('Workflow activation failed:', error);
            showToast(workflowDesk.snapshot().active === null
                ? '切换失败且原工作流无法恢复，已进入安全空画布'
                : '切换失败，已恢复原工作流', 'error');
            return false;
        }
    }

    return { activate };
}
