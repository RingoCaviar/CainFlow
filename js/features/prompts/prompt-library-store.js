export const PROMPT_LIBRARY_STORAGE_KEY = 'cainflow_prompt_library';

function asPromptLibrary(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error('提示词库数据格式不正确');
    return value;
}

export async function readPromptLibrary(storage) {
    if (typeof storage.readCurrentDocument === 'function') {
        const { value } = await storage.readCurrentDocument(PROMPT_LIBRARY_STORAGE_KEY);
        return asPromptLibrary(value);
    }
    return asPromptLibrary(JSON.parse(storage.getItem(PROMPT_LIBRARY_STORAGE_KEY) || '[]'));
}

export function updatePromptLibrary(storage, update, { isCurrent = () => true } = {}) {
    const updateLibrary = value => update(asPromptLibrary(value));
    if (typeof storage.updateCurrentDocument === 'function') {
        return storage.updateCurrentDocument(PROMPT_LIBRARY_STORAGE_KEY, updateLibrary, { isCurrent });
    }
    if (!isCurrent()) throw new Error('请求所属会话已变化');
    const next = updateLibrary(JSON.parse(storage.getItem(PROMPT_LIBRARY_STORAGE_KEY) || '[]'));
    storage.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(next));
    return next;
}
