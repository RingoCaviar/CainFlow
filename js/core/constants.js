/**
 * 定义应用版本、仓库信息、存储键名与默认配置等前端共享常量。
 */
export const APP_VERSION_NUMBER = '3.3.9';
export const APP_VERSION = `v${APP_VERSION_NUMBER}`;
export const APP_ASSET_VERSION = `${APP_VERSION_NUMBER}-model-count`;
export const GITHUB_REPO = 'RingoCaviar/CainFlow';
export const STORAGE_KEY = 'nodeflow_ai_state';
export const LOG_STORAGE_KEY = 'cainflow_logs_state';
export const DEFAULT_THEME_ID = 'light';

// 改成 true 后会关闭启动时的自动更新检测；手动检查与下载更新仍可使用。
export const AUTO_UPDATE_CHECK_DISABLED = false;

export const DB_NAME = 'NodeFlowDB';
export const DB_VERSION = 4;
export const STORE_HANDLES = 'handles';
export const STORE_ASSETS = 'imageAssets';
export const STORE_HISTORY = 'imageHistory';

export const DEFAULT_PROVIDERS = [];

export const DEFAULT_MODELS = [];
/**
 * 汇总前端使用的全局常量、存储键和版本信息。
 */
