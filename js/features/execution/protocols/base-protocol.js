/**
 * 协议工具函数
 * 提供协议相关的通用辅助函数
 *
 * 注意：这些函数主要用于 execution-core 等核心模块
 * 新的纯配置协议不再需要这些函数
 */

/**
 * 规范化图片列表
 * @param {string|string[]} images - 图片URL或URL数组
 * @returns {string[]} 规范化后的图片URL数组
 */
export function normalizeImageList(images) {
    if (!images) return [];
    if (typeof images === 'string') return [images];
    if (Array.isArray(images)) return images.filter(img => typeof img === 'string' && img);
    return [];
}

/**
 * 获取图片输入的键名列表（按顺序排序）
 * @param {Object} inputs - 输入对象
 * @returns {string[]} 排序后的图片键名
 */
export function getImageInputKeys(inputs = {}) {
    return Object.keys(inputs)
        .filter((key) => key === 'image' || /^image_\d+$/.test(key))
        .sort((a, b) => {
            if (a === 'image') return -1;
            if (b === 'image') return 1;
            const numA = parseInt(a.slice('image_'.length), 10) || 0;
            const numB = parseInt(b.slice('image_'.length), 10) || 0;
            return numA - numB;
        });
}

/**
 * 获取参考图片URL列表
 * @param {Object} inputs - 输入对象
 * @returns {string[]} 参考图片URL数组
 */
export function getReferenceImages(inputs = {}) {
    return getImageInputKeys(inputs)
        .flatMap((key) => normalizeImageList(inputs[key]));
}

/**
 * 构建图片对象（用于某些API格式）
 * @param {string} url - 图片URL
 * @returns {Object|null} 图片对象
 */
export function buildImageObject(url) {
    if (!url || typeof url !== 'string') return null;
    return {
        type: 'image_url',
        image_url: { url }
    };
}

/**
 * 获取自定义请求参数
 * @param {Object} inputs - 输入对象
 * @returns {Object} 自定义参数对象
 */
export function getCustomRequestParams(inputs = {}) {
    return Object.entries(inputs.params || {})
        .reduce((acc, [key, value]) => {
            const trimmedKey = String(key || '').trim();
            if (trimmedKey) {
                acc[trimmedKey] = value;
            }
            return acc;
        }, {});
}

/**
 * 应用自定义参数到请求体
 * @param {Object} requestBody - 基础请求体
 * @param {Object} inputs - 输入对象
 * @returns {Object} 合并后的请求体
 */
export function applyCustomParams(requestBody, inputs = {}) {
    return { ...requestBody, ...getCustomRequestParams(inputs) };
}

/**
 * 获取主要文本输入
 * @param {string|string[]} input - 文本输入
 * @returns {string} 文本内容
 */
export function getPrimaryTextInput(input) {
    if (typeof input === 'string') return input;
    if (Array.isArray(input) && input.length > 0) return String(input[0] || '');
    return '';
}

/**
 * 转义HTML特殊字符
 * @param {string} str - 原始字符串
 * @returns {string} 转义后的字符串
 */
export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
