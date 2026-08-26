export function getWorkflowTabRevision(tab) {
    return Number.isSafeInteger(tab?.dataRevision) ? tab.dataRevision : 0;
}

export function replaceWorkflowTabData(tab, data) {
    if (!tab) return null;
    tab.data = data;
    tab.dataRevision = getWorkflowTabRevision(tab) + 1;
    return tab;
}

export function retainActiveWorkflowTabDuringRefresh(tabs, persistedNames, activeWorkflow = {}) {
    const names = new Set(Array.from(persistedNames || []).filter((name) => typeof name === 'string' && name));
    return (tabs || []).filter((tab) => (
        names.has(tab?.name)
        || (!!activeWorkflow.workflowId && tab?.workflowId === activeWorkflow.workflowId)
        || (!activeWorkflow.workflowId
            && !!activeWorkflow.workflowName
            && tab?.name === activeWorkflow.workflowName)
    ));
}

export function captureWorkflowTabRevision(tab, {
    resolveTab = null,
    allowDetached = false
} = {}) {
    const revision = getWorkflowTabRevision(tab);
    const data = tab?.data;
    const workflowId = tab?.workflowId || '';
    return {
        data,
        revision,
        isCurrent: () => {
            const resolvedTab = typeof resolveTab === 'function' && workflowId
                ? resolveTab(workflowId)
                : tab;
            const currentTab = resolvedTab || (allowDetached ? tab : null);
            return currentTab?.data === data && getWorkflowTabRevision(currentTab) === revision;
        }
    };
}
