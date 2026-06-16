/**
 * 图片验证工具函数
 * 纯函数，无副作用
 */

/**
 * 检查是否为内联图片数据（data: URL）
 * @param {*} value - 待检查的值
 * @returns {boolean} 是否为 data:image/ 格式
 */
export function isInlineImageData(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
}

/**
 * 检查是否为远程图片 URL
 * @param {*} value - 待检查的值
 * @returns {boolean} 是否为 http/https URL
 */
export function isRemoteImageUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * 解析分辨率文本（如 "1920x1080"）
 * @param {string} resolutionText - 分辨率文本
 * @returns {{width: number, height: number}|null} 解析后的宽高对象，失败返回 null
 */
export function parseResolutionText(resolutionText) {
    if (!resolutionText) return null;
    const numbers = String(resolutionText).match(/\d+/g);
    if (!numbers || numbers.length < 2) return null;
    return {
        width: parseInt(numbers[0], 10),
        height: parseInt(numbers[1], 10)
    };
}
