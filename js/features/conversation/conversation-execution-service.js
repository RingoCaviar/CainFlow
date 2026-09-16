export class ConversationExecutionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ConversationExecutionError';
        this.code = code;
        this.details = details;
    }
}

function textFromParts(parts = []) {
    return parts.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n');
}

export function projectConversationContext({ conversation, nextUserText, maxCharacters = 48000 }) {
    const durableMessages = (conversation?.messages || [])
        .filter((message) => ['user', 'assistant'].includes(message?.role) && ['completed', 'partial'].includes(message?.status))
        .map((message) => ({ role: message.role, content: textFromParts(message.parts) }))
        .filter((message) => message.content);
    durableMessages.push({ role: 'user', content: String(nextUserText || '') });
    let usedCharacters = 0;
    const projected = [];
    for (let index = durableMessages.length - 1; index >= 0; index -= 1) {
        const message = durableMessages[index];
        if (projected.length > 0 && usedCharacters + message.content.length > maxCharacters) break;
        projected.unshift(message);
        usedCharacters += message.content.length;
    }
    return {
        messages: projected,
        summary: {
            durableMessageCount: durableMessages.length,
            projectedMessageCount: projected.length,
            omittedMessageCount: durableMessages.length - projected.length,
            characterCount: usedCharacters,
            limit: maxCharacters
        }
    };
}

export function createConversationExecutionService({
    api,
    createPlan,
    executePlan,
    now = () => Date.now(),
    maxContextCharacters = 48000,
    maxRetries = 0,
    requestTimeoutMs = 120000,
    resolveMediaAsset = async () => null,
    onStateChange = () => {}
}) {
    const activeRuns = new Map();

    async function persistFinal(run, { status, text, attempts }) {
        const execution = {
            modelId: run.model.id,
            modelName: run.model.name || run.model.modelId || run.model.id,
            providerId: run.provider.id,
            providerName: run.provider.name || run.provider.id,
            systemPromptVersion: run.conversation.systemPromptVersion || 1,
            contextProjection: run.projection.summary,
            status,
            attempts
        };
        const result = await api.updateConversationMessage(run.conversation.id, run.assistantMessageId, {
            revision: run.revision,
            status,
            parts: [{ type: 'text', text }],
            execution
        });
        run.revision = result.conversationRevision;
        return { text, status, execution, message: result.message, conversationRevision: run.revision };
    }

    async function send({ conversation, text, model, provider, contextParts = [] }) {
        if (!conversation?.id) throw new ConversationExecutionError('invalid_conversation', 'Conversation identity is required');
        if (activeRuns.has(conversation.id)) throw new ConversationExecutionError('conversation_busy', '该对话已有请求正在运行');
        if (!String(text || '').trim()) throw new ConversationExecutionError('empty_message', '请输入提问内容');
        const controller = new AbortController();
        const run = {
            conversation, model, provider, controller, revision: conversation.revision,
            partialText: '', assistantMessageId: '', projection: null, attempts: [], timedOut: false
        };
        activeRuns.set(conversation.id, run);
        onStateChange(conversation.id, { status: 'starting', partialText: '' });
        try {
            const userResult = await api.appendConversationMessage(conversation.id, {
                revision: run.revision,
                role: 'user',
                status: 'completed',
                parts: [{ type: 'text', text: String(text).trim() }, ...contextParts]
            });
            run.revision = userResult.conversationRevision;
            const assistantResult = await api.appendConversationMessage(conversation.id, {
                revision: run.revision,
                parentMessageId: userResult.message.id,
                role: 'assistant',
                status: 'pending',
                parts: [{ type: 'text', text: '' }]
            });
            run.revision = assistantResult.conversationRevision;
            run.assistantMessageId = assistantResult.message.id;
            run.projection = projectConversationContext({ conversation, nextUserText: text, maxCharacters: maxContextCharacters });
            const media = [];
            for (const part of contextParts) {
                const candidates = part.type === 'media'
                    ? [{ assetKey: part.assetKey, mediaType: part.mediaType }]
                    : (part.mediaAssetKeys || []).map((assetKey) => ({ assetKey, mediaType: 'image' }));
                for (const candidate of candidates) {
                    const url = await resolveMediaAsset(candidate.assetKey);
                    if (url) media.push({ type: candidate.mediaType || 'image', url });
                }
            }
            const plan = createPlan({
                provider, model,
                protocol: model.protocol || provider.protocol,
                systemPrompt: conversation.systemPrompt || '',
                messages: run.projection.messages,
                media
            });
            const attempts = run.attempts;
            for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
                const attempt = { ordinal: attemptIndex + 1, startedAt: now(), status: 'running' };
                attempts.push(attempt);
                onStateChange(conversation.id, { status: 'running', attempt: attempt.ordinal, partialText: run.partialText });
                let timedOut = false;
                const timeoutId = requestTimeoutMs > 0 ? setTimeout(() => {
                    timedOut = true;
                    run.timedOut = true;
                    controller.abort();
                }, requestTimeoutMs) : null;
                try {
                    const response = await executePlan(plan, {
                        signal: controller.signal,
                        onChunk(chunk) {
                            run.partialText += String(chunk || '');
                            onStateChange(conversation.id, { status: 'streaming', attempt: attempt.ordinal, partialText: run.partialText });
                        }
                    });
                    const responseText = String(response?.text ?? run.partialText ?? '');
                    if (!responseText.trim()) throw new ConversationExecutionError('empty_response', 'API 返回了空回复');
                    run.partialText = responseText;
                    attempt.status = 'completed';
                    attempt.finishedAt = now();
                    if (response?.diagnosticId) attempt.diagnosticId = response.diagnosticId;
                    const completed = await persistFinal(run, { status: 'completed', text: responseText, attempts });
                    onStateChange(conversation.id, { status: 'completed', partialText: responseText });
                    return completed;
                } catch (error) {
                    if (timedOut) {
                        error = new ConversationExecutionError('conversation_timeout', '对话请求超时');
                    }
                    attempt.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
                    attempt.finishedAt = now();
                    attempt.error = { code: error.code || error.name || 'request_failed', message: String(error.message || '请求失败').slice(0, 500) };
                    if (controller.signal.aborted || attemptIndex === maxRetries) throw error;
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }
            }
        } catch (error) {
            if (run.assistantMessageId) {
                const stopped = controller.signal.aborted && !run.timedOut;
                const status = stopped && run.partialText ? 'partial' : (stopped ? 'cancelled' : 'failed');
                await persistFinal(run, { status, text: run.partialText, attempts: run.attempts }).catch(() => {});
                onStateChange(conversation.id, { status, partialText: run.partialText, error });
            }
            throw error;
        } finally {
            activeRuns.delete(conversation.id);
        }
    }

    function stop(conversationId) {
        const run = activeRuns.get(conversationId);
        if (!run) return false;
        run.controller.abort();
        return true;
    }

    function getRunState(conversationId) {
        const run = activeRuns.get(conversationId);
        return run ? { status: run.partialText ? 'streaming' : 'running', partialText: run.partialText } : null;
    }

    async function recoverInterrupted(conversation) {
        let revision = conversation.revision;
        const recovered = [];
        for (const message of conversation.messages || []) {
            if (message.role !== 'assistant' || !['pending', 'streaming'].includes(message.status)) continue;
            const result = await api.updateConversationMessage(conversation.id, message.id, {
                revision,
                status: textFromParts(message.parts) ? 'partial' : 'failed',
                parts: message.parts,
                execution: {
                    ...(message.execution || {}),
                    status: 'interrupted',
                    attempts: message.execution?.attempts || []
                }
            });
            revision = result.conversationRevision;
            recovered.push(result.message);
        }
        return { conversationRevision: revision, messages: recovered };
    }

    return { send, stop, getRunState, recoverInterrupted };
}
