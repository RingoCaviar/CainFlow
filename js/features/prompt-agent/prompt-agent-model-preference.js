// A desktop webview may use a different origin/profile after restart. Persist the
// global chat-model preference through the hydrated disk facade, like panel width.
export const AGENT_CHAT_MODEL_KEY = 'cainflow_prompt_agent_model';
export function createAgentChatModelPreference({ storage, legacyStorage }) {
    function get() {
        const saved = storage.getItem(AGENT_CHAT_MODEL_KEY);
        if (saved !== null) return String(saved);
        let legacy = '';
        try { legacy = String(legacyStorage?.getItem(AGENT_CHAT_MODEL_KEY) || ''); } catch { /* Browser storage can be unavailable. */ }
        if (legacy) storage.setItem(AGENT_CHAT_MODEL_KEY, legacy);
        return legacy;
    }
    function set(value) { storage.setItem(AGENT_CHAT_MODEL_KEY, String(value || '')); }
    return { get, set };
}
