async function requestConversation(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || payload.message || `Conversation request failed: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

export async function listConversations({ status = 'active', workflowId = '', search = '' } = {}) {
    const query = new URLSearchParams({ status });
    if (workflowId) query.set('workflowId', workflowId);
    if (search) query.set('search', search);
    return (await requestConversation(`/api/conversations?${query}`)).conversations || [];
}

export async function getConversation(conversationId) {
    return (await requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}`)).conversation;
}

export async function createConversation(input = {}) {
    return (await requestConversation('/api/conversations', {
        method: 'POST', body: JSON.stringify(input)
    })).conversation;
}

export async function updateConversation(conversationId, input) {
    return (await requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PUT', body: JSON.stringify(input)
    })).conversation;
}

export async function appendConversationMessage(conversationId, input) {
    return requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST', body: JSON.stringify(input)
    });
}

export async function updateConversationMessage(conversationId, messageId, input) {
    return requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, {
        method: 'PUT', body: JSON.stringify(input)
    });
}

export async function resolveConversationMessageMedia(conversationId, messageId, input) {
    return requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/media-actions`, {
        method: 'POST', body: JSON.stringify(input)
    });
}

export async function permanentlyDeleteConversation(conversationId, revision) {
    return requestConversation(`/api/conversations/${encodeURIComponent(conversationId)}?revision=${encodeURIComponent(revision)}`, {
        method: 'DELETE'
    });
}
