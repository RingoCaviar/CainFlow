// Official model pages specify the default reasoning effort. The API reference
// and migration guides specify fields shared by Chat Completions models.
const reasoning = (thinkingProfile, defaultEffort = 'medium', extra = {}) => ({
    thinkingProfile, defaultEffort, systemRole: 'developer', imageInput: true, ...extra
});
const gpt5 = (thinkingProfile, defaultEffort, extra) => reasoning(thinkingProfile, defaultEffort, { verbosity: true, ...extra });
const noReasoningTools = { functionCalling: 'without-reasoning' };
const responsesTools = { functionCalling: 'responses-only' };
const responsesOnly = { chatCompletions: false };
const olderVision = { imageInput: true, thinkingProfile: null };
const olderText = { imageInput: false, thinkingProfile: null };

const profiles = new Map([
    ['gpt-6-astra', gpt5('openai-max', 'medium', responsesTools)],
    ['gpt-6.1-sol', gpt5('openai-max', 'medium', responsesTools)],
    ['gpt-6.1-terra', gpt5('openai-none-max', 'medium', responsesTools)],
    ['gpt-6-sol', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-6-luna', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-5.6', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-5.6-sol', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-5.6-terra', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-5.6-luna', gpt5('openai-none-max', 'medium', noReasoningTools)],
    ['gpt-5.5', gpt5('openai-none-xhigh', 'medium', noReasoningTools)],
    ['gpt-5.4', gpt5('openai-none-xhigh', 'none', noReasoningTools)],
    ['gpt-5.4-mini', gpt5('openai-none-xhigh', 'none', noReasoningTools)],
    ['gpt-5.4-nano', gpt5('openai-none-xhigh', 'none', noReasoningTools)],
    ['gpt-5.2', gpt5('openai-none-xhigh', 'none')],
    ['gpt-5.1', gpt5('openai-none-high', 'none')],
    ['gpt-5', gpt5('openai-gpt5', 'medium', { webSearchNeedsMoreThanMinimal: true })],
    ['gpt-5-mini', gpt5('openai-gpt5')],
    ['gpt-5-nano', gpt5('openai-gpt5')],
    ['o1', reasoning('openai-basic')],
    ['o3', reasoning('openai-basic', 'medium', { stop: false })],
    ['o3-mini', reasoning('openai-basic', 'medium', { imageInput: false })],
    ['o4-mini', reasoning('openai-basic', 'medium', { stop: false })],
    ['gpt-5-pro', gpt5('openai-high', 'high', responsesOnly)],
    ['gpt-5.2-pro', gpt5('openai-medium-xhigh', 'medium', responsesOnly)],
    ['gpt-5.4-pro', gpt5('openai-medium-xhigh', 'medium', responsesOnly)],
    ['gpt-5.5-pro', gpt5('openai-medium-xhigh', 'high', responsesOnly)],
    ['o1-pro', responsesOnly],
    ['o3-pro', responsesOnly],
    ['gpt-4o', olderVision],
    ['gpt-4o-mini', olderVision],
    ['gpt-4.1', olderVision],
    ['gpt-4.1-mini', olderVision],
    ['gpt-4.1-nano', olderVision],
    ['gpt-4-turbo', olderVision],
    ['gpt-4', olderText],
    ['gpt-3.5-turbo', olderText],
]);

export function getOpenAIChatCapabilities({ model = {}, provider = {}, protocol = model.protocol } = {}) {
    if (!['openai', 'responses'].includes(protocol)) return null;
    const endpoint = protocol === 'responses' && provider.autoComplete === false ? provider.responsesEndpoint : provider.endpoint;
    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com') return null;
    } catch {
        return null;
    }
    const id = String(model.modelId || '').toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const profile = profiles.get(id);
    return profile ? { ...profile, systemRole: profile.systemRole || 'system' } : null;
}
