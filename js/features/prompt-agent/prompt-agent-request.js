// One record per dispatched HTTP attempt. Business validation happens afterwards.
export async function trackAgentRequest(plan, execute, { recordRequest = () => {}, workflowId = '', purpose = 'chat', signal } = {}) {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    const id = globalThis.crypto.randomUUID();
    const metadata = { id, source: 'agent', purpose, workflowId, modelId: plan.model?.id || '',
        modelName: plan.model?.name || plan.model?.modelId || '', providerId: plan.provider?.id || '',
        providerName: plan.provider?.name || plan.provider?.id || '', url: plan.url };
    const record = result => { try { recordRequest({ ...metadata, ...result }); } catch { /* Statistics must not turn a completed request into a retry. */ } };
    try {
        const result = await execute();
        if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
        record({ success: true });
        return result;
    } catch (error) {
        record({ success: false, status: error?.details?.status ?? error?.serverResponse?.status ?? null });
        throw error;
    }
}

export function normalizeAgentRequestFailure(value) {
    const { kind, status, retry } = value || {};
    if (!['http', 'connection', 'empty'].includes(kind)) return null;
    if (kind === 'http' && (!Number.isInteger(status) || status < 400 || status > 599)) return null;
    const failure = kind === 'http' ? { kind, status } : { kind };
    if (Number.isSafeInteger(retry?.messageIndex) && retry.messageIndex >= 0
        && Number.isSafeInteger(retry.referenceCount) && retry.referenceCount >= 0
        && Number.isSafeInteger(retry.contextImageCount) && retry.contextImageCount >= 0
        && Array.isArray(retry.selectedIds) && retry.selectedIds.every(id => typeof id === 'string' && id)) {
        failure.retry = { messageIndex: retry.messageIndex, referenceCount: retry.referenceCount,
            contextImageCount: retry.contextImageCount, selectedIds: [...new Set(retry.selectedIds)],
            contextNodeId: typeof retry.contextNodeId === 'string' ? retry.contextNodeId : '',
            imageOnly: retry.imageOnly === true };
    }
    return failure;
}

export function getAgentRequestFailure(error) {
    const status = error?.details?.status ?? error?.serverResponse?.status;
    if (status !== undefined) return normalizeAgentRequestFailure({ kind: 'http', status });
    if (error?.code === 'empty_response') return { kind: 'empty' };
    if (error?.name === 'TypeError' && /failed to fetch|networkerror|network request failed|load failed/i.test(error.message)) {
        return { kind: 'connection' };
    }
    return null;
}

export function agentRequestFailureText({ kind, status }) {
    if (status === 429) return '供应商限制了请求频率或额度。请稍后重试。如果持续失败，请检查供应商额度。';
    if (status === 401 || status === 403) return '供应商拒绝了请求。请检查对话模型的供应商配置和访问权限后重试。';
    if (status >= 500) return '供应商暂时无法响应。请稍后重试。';
    if (kind === 'http') return '供应商未接受这次请求。请检查对话模型与供应商配置后重试。';
    if (kind === 'connection') return '无法连接到供应商。请检查网络后重试。';
    return '供应商返回了空回复。请重试。如果持续失败，请检查模型配置。';
}
