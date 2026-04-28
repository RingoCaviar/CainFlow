/**
 * 定义应用版本、仓库信息、存储键名与默认配置等前端共享常量。
 */
export const APP_VERSION = 'v2.7.6.2';
export const GITHUB_REPO = 'RingoCaviar/CainFlow';
export const STORAGE_KEY = 'nodeflow_ai_state';

export const DB_NAME = 'NodeFlowDB';
export const DB_VERSION = 4;
export const STORE_HANDLES = 'handles';
export const STORE_ASSETS = 'imageAssets';
export const STORE_HISTORY = 'imageHistory';

export const DEFAULT_PROVIDERS = [
    {
        id: 'prov_gxp',
        name: 'GXP',
        type: 'google',
        apikey: '',
        endpoint: 'https://www.6789api.top/',
        autoComplete: true
    },
    {
        id: 'prov_gxp_openai',
        name: 'GXP_OpenAI',
        type: 'openai',
        apikey: '',
        endpoint: 'https://www.6789api.top/',
        autoComplete: true
    }
];

export const DEFAULT_MODELS = [
    { id: 'model_banana_v2', name: '生图-Banana 2', modelId: 'gemini-3.1-flash-image-preview', providerId: 'prov_gxp', taskType: 'image', protocol: 'google' },
    { id: 'model_banana_v1', name: '生图-Banana Pro', modelId: 'gemini-3-pro-image-preview', providerId: 'prov_gxp', taskType: 'image', protocol: 'google' },
    { id: 'model_chat_3_flash', name: '对话-gemini-3-flash-preview', modelId: 'gemini-3-flash-preview', providerId: 'prov_gxp', taskType: 'chat', protocol: 'google' },
    { id: 'model_gpt_image_2', name: 'GPT-Image-2', modelId: 'gpt-image-2', providerId: 'prov_gxp_openai', taskType: 'image', protocol: 'openai' }
];
/**
 * 汇总前端使用的全局常量、存储键和版本信息。
 */
