export const AUTO_COMPACT_STORAGE_KEY = 'cainflow_prompt_agent_auto_compact_tokens';
export const COMPACTION_MODEL_STORAGE_KEY = 'cainflow_prompt_agent_compaction_model_id';
export const DEFAULT_AUTO_COMPACT_TOKENS = 12000;

export function readCompactionModelId(storage) {
    return String(storage?.getItem(COMPACTION_MODEL_STORAGE_KEY) || '');
}

export function writeCompactionModelId(storage, modelId) {
    if (typeof modelId !== 'string') throw new TypeError('压缩模型 ID 无效');
    storage.setItem(COMPACTION_MODEL_STORAGE_KEY, modelId);
    return modelId;
}

export function parseAutoCompactTokens(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function readAutoCompactTokens(storage) {
    return parseAutoCompactTokens(storage?.getItem(AUTO_COMPACT_STORAGE_KEY)) || DEFAULT_AUTO_COMPACT_TOKENS;
}

export function writeAutoCompactTokens(storage, value) {
    const parsed = parseAutoCompactTokens(value);
    if (!parsed) throw new RangeError('自动压缩阈值必须是正整数 Token 数');
    storage.setItem(AUTO_COMPACT_STORAGE_KEY, String(parsed));
    return parsed;
}

export function migrateAutoCompactTokens(storage, models, selectedModelId) {
    if (storage?.getItem(AUTO_COMPACT_STORAGE_KEY) !== null) return readAutoCompactTokens(storage);
    const selected = (models || []).find(model => model.id === selectedModelId);
    const legacy = parseAutoCompactTokens(selected?.autoCompactTokenLimit);
    return legacy ? writeAutoCompactTokens(storage, legacy) : DEFAULT_AUTO_COMPACT_TOKENS;
}
