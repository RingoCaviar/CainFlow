/**
 * Runs an ImageGenerate node from the conversation workspace without duplicating
 * provider-specific image request logic. The canvas remains the durable home for
 * the generated result.
 */
export function createConversationImageGenerationService({
    ensureWorkflow = async () => true,
    createImageNode = () => null,
    executeImageNode = async () => ({}),
    onStateChange = () => {}
} = {}) {
    const runs = new Map();

    async function generate({ conversationId, prompt, model, provider }) {
        if (!conversationId) throw new Error('请先创建或选择一个对话');
        if (!String(prompt || '').trim()) throw new Error('请先描述想生成的图片');
        if (!model || !provider) throw new Error('请先选择可用的生图模型与 Provider');
        if (runs.has(conversationId)) throw new Error('当前对话正在生成图片');
        if (!(await ensureWorkflow())) throw new Error('请先创建或打开一个工作流以保存生图结果');

        const controller = new AbortController();
        runs.set(conversationId, controller);
        onStateChange(conversationId, { status: 'running', kind: 'image' });
        try {
            const node = createImageNode({ prompt: String(prompt).trim(), model, provider });
            if (!node) throw new Error('无法创建图片生成节点');
            const result = await executeImageNode(node, controller.signal);
            onStateChange(conversationId, { status: 'completed', kind: 'image', nodeId: node.id });
            return { nodeId: node.id, result };
        } catch (error) {
            onStateChange(conversationId, { status: controller.signal.aborted ? 'cancelled' : 'failed', kind: 'image', error });
            throw error;
        } finally {
            runs.delete(conversationId);
        }
    }

    function stop(conversationId) {
        const controller = runs.get(conversationId);
        if (!controller) return false;
        controller.abort();
        return true;
    }

    return { generate, stop, getRunState: (conversationId) => runs.has(conversationId) ? { status: 'running', kind: 'image' } : null };
}
