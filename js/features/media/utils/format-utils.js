/**
 * 格式化工具函数
 * 纯函数，无副作用
 */

/**
 * 格式化字节数为人类可读的格式（用于预计大小）
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的字符串，如 "1.5 MB"
 */
export function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1024 * 1024) return `预计 ${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `预计 ${(bytes / 1024).toFixed(1)} KB`;
    return `预计 ${bytes} B`;
}

/**
 * 格式化字节数为人类可读的格式（用于进度显示）
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的字符串，如 "1.50 MB"
 */
export function formatProgressBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${Math.round(bytes)} B`;
}

/**
 * 格式化下载/上传速度
 * @param {number} bytesPerSecond - 每秒字节数
 * @returns {string} 格式化后的速度字符串，如 "1.5 MB/s"
 */
export function formatProgressSpeed(bytesPerSecond) {
    const speed = Number(bytesPerSecond) || 0;
    return speed > 0 ? `${formatProgressBytes(speed)}/s` : '等待数据';
}

/**
 * HTML 实体转义
 * @param {*} value - 需要转义的值
 * @returns {string} 转义后的字符串
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
