// Static image requests supported by the canvas. See the OpenAI Images API
// reference and the image generation guide for model and endpoint constraints.
const STATIC_GPT_IMAGE = {
    sizeProfile: 'gpt-image-1',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    qualities: ['auto', 'low', 'medium', 'high'],
    backgrounds: ['auto', 'transparent', 'opaque'],
    moderations: ['auto', 'low'],
    outputFormats: ['png', 'jpeg', 'webp'],
    inputFidelities: [],
    styles: [],
    responseFormats: [],
    complexities: [],
    maxReferences: 16
};

const FLEXIBLE_GPT_IMAGE = { ...STATIC_GPT_IMAGE, sizeProfile: 'flexible', sizes: null };
const HIGH_QUALITIES = [...STATIC_GPT_IMAGE.qualities, 'xhigh', 'max'];
const GPT_IMAGE_1 = { ...STATIC_GPT_IMAGE, inputFidelities: ['low', 'high'] };
const GPT_IMAGE_1_MINI = { ...STATIC_GPT_IMAGE, inputFidelities: ['low'] };
const GPT_IMAGE_2_5 = { ...FLEXIBLE_GPT_IMAGE, qualities: HIGH_QUALITIES };
const GPT_IMAGE_2_6 = {
    ...STATIC_GPT_IMAGE,
    qualities: HIGH_QUALITIES,
    complexities: ['low', 'medium', 'high']
};

// Retired models may still be configured against a compatibility provider.
const DALL_E_2 = {
    sizeProfile: 'dall-e-2',
    sizes: ['256x256', '512x512', '1024x1024'],
    qualities: ['standard'],
    backgrounds: [],
    moderations: [],
    outputFormats: [],
    inputFidelities: [],
    styles: [],
    responseFormats: ['url', 'b64_json'],
    complexities: [],
    maxReferences: 1
};
const DALL_E_3 = {
    ...DALL_E_2,
    sizeProfile: 'dall-e-3',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    qualities: ['standard', 'hd'],
    styles: ['vivid', 'natural'],
    maxReferences: 0
};

export function getOpenAiImageCapabilities(modelId) {
    const model = String(modelId || '').trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
    switch (model) {
        case 'gpt-image-1':
        case 'gpt-image-1.5': return GPT_IMAGE_1;
        case 'gpt-image-1-mini': return GPT_IMAGE_1_MINI;
        case 'chatgpt-image-latest': return STATIC_GPT_IMAGE;
        case 'gpt-image-2': return FLEXIBLE_GPT_IMAGE;
        case 'gpt-image-2.5-sunburst':
        case 'gpt-image-2.5-flare': return GPT_IMAGE_2_5;
        case 'gpt-image-2.6-sunburst':
        case 'gpt-image-2.6-flare': return GPT_IMAGE_2_6;
        case 'dall-e-2': return DALL_E_2;
        case 'dall-e-3': return DALL_E_3;
        default: return null;
    }
}
