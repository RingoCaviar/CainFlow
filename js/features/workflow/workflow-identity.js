export function ensureUniqueWorkflowIdentities(tabs, createWorkflowId) {
    const seen = new Set();
    for (const tab of tabs || []) {
        if (!tab || typeof tab !== 'object') continue;
        let workflowId = tab.workflowId || tab.data?.workflowId || '';
        if (!workflowId || seen.has(workflowId)) workflowId = createWorkflowId();
        while (!workflowId || seen.has(workflowId)) workflowId = createWorkflowId();
        tab.workflowId = workflowId;
        if (tab.data && typeof tab.data === 'object') tab.data.workflowId = workflowId;
        seen.add(workflowId);
    }
    return tabs;
}

export function normalizeWorkflowReference(workflow) {
    return typeof workflow === 'string'
        ? { workflowName: workflow, workflowId: '' }
        : { workflowName: workflow?.workflowName || '', workflowId: workflow?.workflowId || '' };
}

export function requireStableWorkflowReference(workflow) {
    const reference = normalizeWorkflowReference(workflow);
    if (!reference.workflowId) {
        throw new TypeError('A workflow reference with a stable workflowId is required');
    }
    return reference;
}

export function isWorkflowReferenceActive(workflow, state) {
    const reference = normalizeWorkflowReference(workflow);
    return reference.workflowId
        ? state?.activeWorkflowId === reference.workflowId
        : !!reference.workflowName && state?.activeWorkflowName === reference.workflowName;
}
