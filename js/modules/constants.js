/**
 * CainFlow — Constants & Configuration
 * Centralized static data for application configuration, database names, and node definitions.
 */

export const APP_VERSION = 'v2.6.1';
export const GITHUB_REPO = 'RingoCaviar/CainFlow';

// ===== Storage & Persistence =====
export const STORAGE_KEY = 'nodeflow_ai_state';

// ===== IndexedDB Configuration =====
export const DB_NAME = 'NodeFlowDB';
export const DB_VERSION = 4;
export const STORE_HANDLES = 'handles';
export const STORE_ASSETS = 'imageAssets';
export const STORE_HISTORY = 'imageHistory';

// ===== Default State Configuration =====
export const DEFAULT_PROVIDERS = [
    { id: 'prov_gxp', name: 'GXP', type: 'google', apikey: '', endpoint: 'https://www.6789api.top/', autoComplete: true }
];

export const DEFAULT_MODELS = [
    { id: 'model_banana_v2', name: '生图-Banana 2', modelId: 'gemini-3.1-flash-image-preview', providerId: 'prov_gxp' },
    { id: 'model_banana_v1', name: '生图-Banana Pro', modelId: 'gemini-3-pro-image-preview', providerId: 'prov_gxp' },
    { id: 'model_chat_3_flash', name: '对话-gemini-3-flash-preview', modelId: 'gemini-3-flash-preview', providerId: 'prov_gxp' }
];

// ===== Node Configurations =====
export const NODE_CONFIGS = {
    ImageImport: {
        title: '图片导入', cssClass: 'node-import',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        inputs: [], outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
        defaultWidth: 240
    },
    ImageGenerate: {
        title: '图片生成 (Gemini)', cssClass: 'node-generate',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
        inputs: [
            { name: 'prompt', type: 'text', label: '提示词输入' },
            { name: 'image_1', type: 'image', label: '参考图 1' },
            { name: 'image_2', type: 'image', label: '参考图 2' },
            { name: 'image_3', type: 'image', label: '参考图 3' },
            { name: 'image_4', type: 'image', label: '参考图 4' },
            { name: 'image_5', type: 'image', label: '参考图 5' }
        ],
        outputs: [{ name: 'image', type: 'image', label: '图片输出' }]
    },
    TextChat: {
        title: '智能对话', cssClass: 'node-chat',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2-2z"/></svg>',
        inputs: [
            { name: 'prompt', type: 'text', label: '提问输入' },
            { name: 'image_1', type: 'image', label: '参考图 1' },
            { name: 'image_2', type: 'image', label: '参考图 2' },
            { name: 'image_3', type: 'image', label: '参考图 3' },
            { name: 'image_4', type: 'image', label: '参考图 4' },
            { name: 'image_5', type: 'image', label: '参考图 5' }
        ],
        outputs: [{ name: 'text', type: 'text', label: '回复文本' }],
        defaultWidth: 380, defaultHeight: 720
    },
    TextInput: {
        title: '文本输入', cssClass: 'node-text-in',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
        inputs: [], outputs: [{ name: 'text', type: 'text', label: '文本输出' }],
        defaultWidth: 260, defaultHeight: 180
    },
    TextDisplay: {
        title: '文本显示', cssClass: 'node-text-out',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        inputs: [{ name: 'text', type: 'text', label: '文本输入' }], outputs: [],
        defaultWidth: 260, defaultHeight: 180
    },
    ImagePreview: {
        title: '图片预览', cssClass: 'node-preview',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: [],
        defaultWidth: 240, defaultHeight: 300
    },
    ImageSave: {
        title: '图片保存', cssClass: 'node-save',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: [],
        defaultWidth: 240
    }
};
