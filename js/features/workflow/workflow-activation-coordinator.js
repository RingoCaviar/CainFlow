import { ensureUniqueWorkflowIdentities } from './workflow-identity.js';
import { migrateLegacyWorkflowData } from '../persistence/legacy-node-migration.js';
import { rollbackWorkflowActivation } from './workflow-rollback.js';
import {
    captureWorkflowTabRevision,
    replaceWorkflowTabData
} from './workflow-tab-revision.js';

export function createWorkflowSessionActivator({
    state,
    workflowActivation,
    createWorkflowId = () => globalThis.crypto?.randomUUID?.()
        || `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`,
    prepareEditorView = null,
    applyViewport = () => {},
    onViewApplied = () => {}
}) {
    function reconcileActiveTab(tab) {
        const workflowId = tab?.workflowId || tab?.data?.workflowId || '';
        const workflowName = tab?.name || '';
        if (!workflowId || !workflowName) return false;
        state.activeWorkflowName = workflowName;
        state.activeWorkflowId = workflowId;
        workflowActivation.setActiveKey(workflowId);
        return true;
    }

    function activate(restoredState) {
        const workflowTabs = Array.isArray(restoredState?.workflowTabs) ? restoredState.workflowTabs : [];
        let activeWorkflowName = restoredState?.activeWorkflowName || '';
        let activeWorkflowId = restoredState?.activeWorkflowId || '';
        const namedActiveTab = workflowTabs.find((tab) => tab?.name === activeWorkflowName);
        const storedIdMatches = workflowTabs.filter((tab) => (
            tab?.workflowId === activeWorkflowId || tab?.data?.workflowId === activeWorkflowId
        ));
        if (activeWorkflowId && storedIdMatches.length === 0 && namedActiveTab
            && !namedActiveTab.workflowId && !namedActiveTab.data?.workflowId) {
            namedActiveTab.workflowId = activeWorkflowId;
        }
        ensureUniqueWorkflowIdentities(workflowTabs, createWorkflowId);
        const authoritativeIdentityTab = storedIdMatches.length === 1 ? storedIdMatches[0] : null;
        const activeTab = authoritativeIdentityTab || namedActiveTab;
        activeWorkflowId = activeTab?.workflowId || '';
        activeWorkflowName = activeTab?.name || activeWorkflowName;
        const activationKey = activeWorkflowId || (activeWorkflowName ? `path:${activeWorkflowName}` : 'session:empty');

        return workflowActivation.activate(activationKey, {
            force: true,
            prepare: async () => {
                const workflowData = {
                    ...(restoredState?.workflowData || {}),
                    workflowId: activeWorkflowId || restoredState?.workflowData?.workflowId || ''
                };
                const editorView = typeof prepareEditorView === 'function'
                    ? await prepareEditorView(activeWorkflowName, workflowData)
                    : null;
                return {
                    workflowTabs,
                    activeWorkflowName,
                    activeWorkflowId,
                    workflowOrder: Array.isArray(restoredState?.workflowOrder) ? restoredState.workflowOrder : [],
                    workflowFolders: Array.isArray(restoredState?.workflowFolders) ? restoredState.workflowFolders : [],
                    editorView,
                    dispose: () => editorView?.dispose?.()
                };
            },
            commit: async (prepared, transaction) => {
                prepared.previous = {
                    workflowTabs: state.workflowTabs,
                    activeWorkflowName: state.activeWorkflowName,
                    activeWorkflowId: state.activeWorkflowId,
                    workflowOrder: state.workflowOrder,
                    workflowFolders: state.workflowFolders
                };
                if (await prepared.editorView?.commit?.({ signal: transaction.signal }) === false) return false;
                state.workflowTabs = prepared.workflowTabs;
                state.activeWorkflowName = prepared.activeWorkflowName;
                state.activeWorkflowId = prepared.activeWorkflowId;
                state.workflowOrder = prepared.workflowOrder;
                state.workflowFolders = prepared.workflowFolders;
                return true;
            },
            rollback: async (prepared) => {
                if (!prepared?.previous) return false;
                if (prepared.editorView?.rollback?.() === false) return false;
                state.workflowTabs = prepared.previous.workflowTabs;
                state.activeWorkflowName = prepared.previous.activeWorkflowName;
                state.activeWorkflowId = prepared.previous.activeWorkflowId;
                state.workflowOrder = prepared.previous.workflowOrder;
                state.workflowFolders = prepared.previous.workflowFolders;
                return true;
            },
            finalize: (prepared) => {
                prepared.editorView?.finalize?.();
                applyViewport();
                onViewApplied({
                    workflowName: prepared.activeWorkflowName,
                    workflowId: prepared.activeWorkflowId
                });
            }
        });
    }

    return { activate, reconcileActiveTab };
}

export function createWorkflowTargetActivator({
    state,
    workflowActivation,
    createWorkflowId,
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
    async function activate(name, { reloadFromFile = false } = {}) {
        if (!name) return false;
        const existingTab = getWorkflowTab(name);
        if (reloadFromFile && existingTab?.running === true) {
            showToast('工作流正在后台运行，暂不能从文件重载', 'warning');
            return false;
        }
        const stableActivationKey = existingTab ? ensureWorkflowIdentity(existingTab) : `path:${name}`;
        const activationKey = reloadFromFile ? `reload:${stableActivationKey}:${Date.now()}` : stableActivationKey;
        if (!reloadFromFile && state.activeWorkflowName === name && workflowActivation.retainActive(activationKey)) {
            return true;
        }

        return workflowActivation.activate(activationKey, {
            getActiveKey: (prepared) => prepared?.tab?.workflowId || activationKey,
            prepare: async ({ signal, token }) => {
                let tab = getWorkflowTab(name);
                let createdTab = false;
                let reloadedData = null;
                if (!tab || reloadFromFile) {
                    const data = await loadWorkflowFromFile(name);
                    if (signal.aborted || !data) return null;
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
                tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === stableWorkflowId) || tab;
                const targetData = reloadedData || tab.data;
                const targetRevision = captureWorkflowTabRevision(tab, {
                    resolveTab: (workflowId) => (state.workflowTabs || [])
                        .find((candidate) => candidate.workflowId === workflowId) || null,
                    allowDetached: createdTab
                });
                const preparedView = await prepareWorkflowView(targetData, {
                    signal,
                    isCurrent: () => workflowActivation.isCurrent(token)
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
                if (signal.aborted || !workflowActivation.isCurrent(token)) {
                    editorView?.dispose?.();
                    return null;
                }
                return {
                    tab,
                    createdTab,
                    reloadedData,
                    targetRevision,
                    preparedView,
                    editorView,
                    dispose: () => editorView?.dispose?.()
                };
            },
            validate: (prepared) => {
                const currentTab = (state.workflowTabs || [])
                    .find((candidate) => candidate.workflowId === prepared?.tab?.workflowId) || prepared?.tab;
                if (prepared?.reloadedData && currentTab?.running === true) return null;
                return prepared?.targetRevision?.isCurrent() === true;
            },
            commit: async (prepared, transaction) => {
                if (!prepared?.tab || !transaction.isCurrent()) return false;
                snapshotActiveWorkflow();
                const previousActiveName = state.activeWorkflowName;
                const previousActiveTab = getWorkflowTab(previousActiveName);
                const previousData = previousActiveTab ? cloneWorkflowData(previousActiveTab.data) : getEmptyWorkflowData();
                prepared.previous = {
                    name: previousActiveName,
                    workflowId: state.activeWorkflowId || ensureWorkflowIdentity(previousActiveTab),
                    data: previousData,
                    preparedView: {
                        data: previousData,
                        modelResolution: resolveWorkflowModelReferences(previousData, state)
                    },
                    undoStack: Array.isArray(state.undoStack) ? state.undoStack.slice() : []
                };
                const { tab, createdTab } = prepared;
                if (prepared.reloadedData && !createdTab) {
                    prepared.previousTarget = {
                        data: cloneWorkflowData(tab.data),
                        dataRevision: tab.dataRevision,
                        dirty: tab.dirty === true,
                        runResult: tab.runResult || ''
                    };
                    prepared.reloadedData.workflowId = ensureWorkflowIdentity(tab);
                    replaceWorkflowTabData(tab, prepared.reloadedData);
                    tab.dirty = false;
                }
                if (createdTab && !getWorkflowTab(name)) {
                    ensureUniqueWorkflowIdentities([...state.workflowTabs, tab], createWorkflowId);
                    state.workflowTabs.push(tab);
                }
                const committedTab = (state.workflowTabs || [])
                    .find((candidate) => candidate.workflowId === tab.workflowId) || tab;
                prepared.activeWorkflowName = committedTab.name;
                state.activeWorkflowName = prepared.activeWorkflowName;
                state.activeWorkflowId = ensureWorkflowIdentity(tab);
                if (!transaction.isCurrent() || await prepared.editorView?.commit?.({ signal: transaction.signal }) === false) return false;
                clearUndoStack();
                updatePortStyles();
                applyViewport();
                return true;
            },
            finalize: (prepared) => {
                prepared.editorView?.finalize?.();
                const effects = [
                    () => onViewApplied({
                        workflowName: prepared.activeWorkflowName,
                        workflowId: state.activeWorkflowId
                    }),
                    onConnectionsChanged,
                    () => scheduleAssetCleanup({ includeCanvas: true }),
                    () => showToast(`已打开工作流: ${prepared.activeWorkflowName}`, 'success'),
                    renderWorkflowList,
                    () => scheduleSave({ dirty: false })
                ];
                effects.forEach((effect) => {
                    try { effect(); } catch (error) {
                        console.warn('Workflow activation finalizer failed:', error);
                    }
                });
            },
            rollback: async (prepared) => {
                const previous = prepared?.previous;
                if (!previous) {
                    prepared?.editorView?.dispose?.();
                    return { safeEmpty: false };
                }
                return rollbackWorkflowActivation({
                    prepared,
                    restorePrevious: async () => {
                        if (prepared.editorView?.rollback?.() === false) return false;
                        state.activeWorkflowName = previous.name;
                        state.activeWorkflowId = previous.workflowId;
                        state.undoStack = previous.undoStack;
                        updatePortStyles();
                        applyViewport();
                        onViewApplied({ workflowName: previous.name, workflowId: previous.workflowId });
                        return true;
                    },
                    cleanupCreatedTarget: (tab) => {
                        state.workflowTabs = (state.workflowTabs || []).filter((item) => item !== tab);
                        releaseWorkflowTabMemory(tab);
                    },
                    restoreExistingTarget: (tab, snapshot) => {
                        tab.data = snapshot.data;
                        tab.dataRevision = snapshot.dataRevision;
                        tab.dirty = snapshot.dirty;
                        tab.runResult = snapshot.runResult;
                    },
                    enterSafeEmpty,
                    reveal: () => {},
                    render: renderWorkflowList,
                    onRestoreError: (error) => console.error('Workflow activation rollback failed:', error)
                });
            }
        });
    }

    return { activate };
}
