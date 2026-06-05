/**
 * 定义应用版本、仓库信息、存储键名与默认配置等前端共享常量。
 */
export const APP_VERSION_NUMBER = '3.1.1';
export const APP_VERSION = `v${APP_VERSION_NUMBER}`;
export const APP_ASSET_VERSION = `${APP_VERSION_NUMBER}-model-count`;
export const GITHUB_REPO = 'RingoCaviar/CainFlow';
export const STORAGE_KEY = 'nodeflow_ai_state';
export const LOG_STORAGE_KEY = 'cainflow_logs_state';

// 改成 true 后会关闭启动时的自动更新检测；手动检查与下载更新仍可使用。
export const AUTO_UPDATE_CHECK_DISABLED = false;

// 改成 true 后会锁定 API 供应商：隐藏新增/删除入口，并禁止修改供应商 API 地址。
export const API_PROVIDERS_LOCKED = AUTO_UPDATE_CHECK_DISABLED;

export const DB_NAME = 'NodeFlowDB';
export const DB_VERSION = 4;
export const STORE_HANDLES = 'handles';
export const STORE_ASSETS = 'imageAssets';
export const STORE_HISTORY = 'imageHistory';

export const DEFAULT_PROVIDERS = [
    {
        id: 'prov_gxp',
        name: 'GXP',
        type: 'openai',
        apikey: '',
        endpoint: 'https://www.6789api.top/',
        autoComplete: true
    }
];

export const DEFAULT_MODELS = [
    { id: 'model_banana_v2', name: '生图-Banana 2', modelId: 'gemini-3.1-flash-image-preview', providerIds: ['prov_gxp'], taskType: 'image', protocol: 'google' },
    { id: 'model_banana_v1', name: '生图-Banana Pro', modelId: 'gemini-3-pro-image-preview', providerIds: ['prov_gxp'], taskType: 'image', protocol: 'google' },
    { id: 'model_gpt_image_2', name: '生图-gpt-image-2', modelId: 'gpt-image-2', providerIds: ['prov_gxp'], taskType: 'image', protocol: 'openai' },
    { id: 'model_gpt_image_2_vip', name: '生图-gpt-image-2-vip', modelId: 'gpt-image-2-vip', providerIds: ['prov_gxp'], taskType: 'image', protocol: 'openai' },
    { id: 'model_chat_3_flash', name: '对话-gemini-3-flash-preview', modelId: 'gemini-3-flash-preview', providerIds: ['prov_gxp'], taskType: 'chat', protocol: 'google' }
];
/**
 * 汇总前端使用的全局常量、存储键和版本信息。
 */
