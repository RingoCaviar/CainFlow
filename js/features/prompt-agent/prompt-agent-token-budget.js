import { createPromptAgentInput } from './prompt-agent-input.js';
import { PROMPT_AGENT_SYSTEM_PROMPT } from './prompt-agent-instructions.js';
import { countO200k, countCl100k } from '../../vendor/tokenizer.js';
import { measureImageTokens } from './prompt-agent-image-tokens.js';

export const DEFAULT_AUTO_COMPACT_TOKENS = 12000;

const textCache = new Map();
const literalOptions = { disallowedSpecial: new Set() };

export function countPromptText(text, encoding = 'o200k_base') {
    const key = encoding + ':' + text;
    if (textCache.has(key)) return textCache.get(key);
    const count = (encoding === 'cl100k_base' ? countCl100k : countO200k)(text, literalOptions);
    if (text.length < 32000) {
        if (textCache.size >= 128) textCache.delete(textCache.keys().next().value);
        textCache.set(key, count);
    }
    return count;
}

export function measurePromptAgentContext(request, observation = null) {
    const input = createPromptAgentInput(request);
    const modelId = String(request.model?.modelId || '');
    const legacy = /^gpt-(?:3\.5|4(?:-|$))/.test(modelId);
    const known = request.model?.protocol !== 'google' && (legacy || /^(?:gpt-4o|gpt-4\.1|gpt-5|o[134])(?:[.-]|$)/.test(modelId));
    const encoding = legacy ? 'cl100k_base' : 'o200k_base';
    // Count actual message strings, not an extra serialization of the envelope.
    const messages = [{ role: 'system', content: PROMPT_AGENT_SYSTEM_PROMPT }, ...input.messages];
    const textTokens = 3 + messages.reduce((sum, message) => sum + 3
        + countPromptText(message.role, encoding) + countPromptText(message.content, encoding), 0);
    const images = input.media.map(item => item.url);
    const costs = images.map(url => measureImageTokens(url, modelId));
    const imageTokens = costs.reduce((sum, cost) => sum + cost.tokens, 0);
    const modelKey = JSON.stringify(request.model || null);
    let used = textTokens + imageTokens;
    let source = `${encoding} 分词${known ? '' : '（模型编码未确认）'}；消息封装为估算${images.length ? (costs.some(cost => cost.estimated) ? '；图片含保守预留' : '；图片按尺寸及模型规则估算') : ''}`;
    // Only reuse the server anchor for the same model configuration and images.
    const anchor = observation?.measurement;
    if (Number.isSafeInteger(observation?.inputTokens) && observation.inputTokens > 0
        && anchor?.modelKey === modelKey && images.length === anchor.images.length
        && images.every((url, index) => url === anchor.images[index])) {
        used = Math.max(0, observation.inputTokens + textTokens - anchor.textTokens);
        source = '接口实际输入用量校准 + 当前文本分词增量（估算）';
    }
    const configured = request.model?.autoCompactTokenLimit;
    const threshold = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_AUTO_COMPACT_TOKENS;
    return { used, threshold, percent: Math.min(100, Math.floor(used / threshold * 100)), reached: used >= threshold,
        source, textTokens, imageTokens, modelKey, images };
}
