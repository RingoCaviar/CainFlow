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
