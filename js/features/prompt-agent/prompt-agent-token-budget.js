import { createPromptAgentInput } from './prompt-agent-input.js';
import { getPromptAgentInstructions } from './prompt-agent-instructions.js';
import { countO200k, countCl100k } from '../../vendor/tokenizer.js';
import { measureImageTokens } from './prompt-agent-image-tokens.js';
import { DEFAULT_AUTO_COMPACT_TOKENS, parseAutoCompactTokens } from './auto-compact-preference.js';
import { getPromptAgentReferenceKey } from './prompt-agent-conversation-store.js';

export { DEFAULT_AUTO_COMPACT_TOKENS };

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
    const messages = [{ role: 'system', content: getPromptAgentInstructions(request.canvasContext) }, ...input.messages];
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
    const threshold = parseAutoCompactTokens(request.autoCompactTokenLimit) || DEFAULT_AUTO_COMPACT_TOKENS;
    return { used, threshold, percent: Math.min(100, Math.floor(used / threshold * 100)), reached: used >= threshold,
        source, textTokens, imageTokens, modelKey, images };
}

export function fitPromptAgentContext(request, resolveContext, observation) {
    const { conversation, referenceImages = [], workflowReferenceImages = [] } = request;
    const { used, threshold } = measurePromptAgentContext(request, observation);
    if (used <= threshold) return { request };

    const { messages, archivedMessages = [], messageOffset = 0 } = conversation;
    const hasEarlierContext = archivedMessages.length || conversation.memory || conversation.contextSummary
        || conversation.previousPromptPlan || conversation.referenceImages?.length;
    const question = messages.at(-1);
    const answeringQuestion = question?.choices?.length && (!request.message
        || request.choiceAnswer?.question === question.text || question.choices.includes(request.message));
    const lastUser = answeringQuestion ? messages.findLastIndex(turn => turn.role === 'user') : -1;
    const end = lastUser >= 0 ? lastUser : messages.length;
    if (!end && !hasEarlierContext) return { request };

    // A summary represents its entire archived prefix. Drop it as a unit, then
    // cut only at user-turn boundaries so answers aren't detached from requests.
    const boundaries = [0];
    messages.slice(1, end).forEach((turn, index) => { if (turn.role === 'user') boundaries.push(index + 1); });
    if (end) boundaries.push(end);
    function project(start) {
        const remaining = messages.slice(start);
        const discardedMessageCount = messageOffset + archivedMessages.length + start;
        const projected = { ...conversation, messages: remaining, archivedMessages: [], messageOffset: discardedMessageCount,
            memory: '', contextSummary: '', previousPromptPlan: null, referenceImages: [] };
        const referenceKeys = new Set([...referenceImages, ...remaining.flatMap(turn => turn.referenceImages || [])]
            .map(getPromptAgentReferenceKey));
        const references = workflowReferenceImages.filter(image => image.contextOrigin === '当前画布素材'
            || referenceKeys.has(getPromptAgentReferenceKey(image)) || image.messageNumber > discardedMessageCount);
        return { discardedMessageCount, request: { ...request, conversation: projected, workflowMemory: '',
            context: resolveContext(projected), workflowReferenceImages: references } };
    }

    // Always keep the current prompt, its attachments, and explicit canvas context,
    // even if those inputs alone exceed the history budget.
    let lower = 0, upper = boundaries.length - 1;
    let fitted = project(boundaries[upper]);
    while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2);
        const candidate = project(boundaries[middle]);
        if (measurePromptAgentContext(candidate.request, observation).used <= threshold) {
            fitted = candidate;
            upper = middle - 1;
        } else lower = middle + 1;
    }
    return fitted;
}
