// Native GenerateContent models and their output parameters.
// https://aistudio.google.com/docs/image-generation?generate-content=true
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-understanding
const STANDARD_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const PANORAMIC_RATIOS = [...STANDARD_RATIOS, '1:4', '4:1', '1:8', '8:1'];
const STANDARD_SIZES = ['1K', '2K', '4K'];
const FLASH_THINKING_LEVELS = ['minimal', 'high'];
const BANANA_THINKING_LEVELS = ['minimal', 'medium', 'high'];

const GEMINI_25_FLASH = {
    maxReferences: 3,
    aspectRatios: STANDARD_RATIOS,
    imageSizes: [],
    search: false,
    imageSearch: false,
    thinkingLevels: []
};

const GEMINI_3_PRO = {
    maxReferences: 14,
    aspectRatios: STANDARD_RATIOS,
    imageSizes: STANDARD_SIZES,
    search: true,
    imageSearch: false,
    thinkingLevels: []
};

const GEMINI_31_FLASH = {
    ...GEMINI_3_PRO,
    aspectRatios: PANORAMIC_RATIOS,
    imageSizes: ['512', ...STANDARD_SIZES],
    imageSearch: true,
    thinkingLevels: FLASH_THINKING_LEVELS
};

const GEMINI_31_FLASH_LITE = {
    ...GEMINI_25_FLASH,
    maxReferences: 14,
    aspectRatios: PANORAMIC_RATIOS,
    thinkingLevels: FLASH_THINKING_LEVELS
};

const GEMINI_NANO_BANANA_21 = {
    ...GEMINI_31_FLASH,
    imageSizes: STANDARD_SIZES,
    thinkingLevels: BANANA_THINKING_LEVELS
};

// Imagen generation used a separate Predict API and accepted text prompts.
const IMAGEN_GENERATE = { maxReferences: 0, search: false, imageSearch: false, thinkingLevels: [] };

export function getGoogleImageCapabilities(modelId) {
    const model = String(modelId || '').trim().toLowerCase().replace(/^models\//, '');
    switch (model) {
        case 'gemini-2.5-flash-image':
        case 'gemini-2.5-flash-image-preview':
        case 'gemini-2.5-flash-image-generation-preview': return GEMINI_25_FLASH;
        case 'gemini-3-pro-image':
        case 'gemini-3-pro-image-preview': return GEMINI_3_PRO;
        case 'gemini-3.1-flash-image':
        case 'gemini-3.1-flash-image-preview': return GEMINI_31_FLASH;
        case 'gemini-3.1-flash-lite-image':
        case 'gemini-3.1-flash-lite-image-preview': return GEMINI_31_FLASH_LITE;
        case 'gemini-nano-banana-2.1': return GEMINI_NANO_BANANA_21;
        case 'imagen-3.0-generate-002':
        case 'imagen-4.0-generate-001':
        case 'imagen-4.0-generate-preview-06-06':
        case 'imagen-4.0-fast-generate-001':
        case 'imagen-4.0-fast-generate-preview-06-06':
        case 'imagen-4.0-ultra-generate-001':
        case 'imagen-4.0-ultra-generate-preview-06-06': return IMAGEN_GENERATE;
        default: return undefined;
    }
}
