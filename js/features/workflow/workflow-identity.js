export function ensureWorkflowDocumentIdentity(tab, createWorkflowId, data = tab?.data) {
    if (!tab || typeof tab !== 'object') return '';
    const workflowId = tab.workflowId || data?.workflowId || createWorkflowId();
    tab.workflowId = workflowId;
    if (data && typeof data === 'object') data.workflowId = workflowId;
    return workflowId;
}

export function normalizeWorkflowReference(workflow) {
    return workflow && typeof workflow === 'object'
        ? { workflowName: workflow.workflowName || '', workflowId: workflow.workflowId || '' }
        : { workflowName: '', workflowId: '' };
}

export function requireStableWorkflowReference(workflow) {
    const reference = normalizeWorkflowReference(workflow);
    if (!reference.workflowId) {
        throw new TypeError('A workflow reference with a stable workflowId is required');
    }
    return reference;
}
