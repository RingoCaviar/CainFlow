/**
 * 预览索引管理模块
 * 管理图片预览和保存节点的当前预览索引
 */

/**
 * 创建预览索引管理器
 * @param {object} deps - 依赖项
 * @param {Function} deps.scheduleSave - 调度保存的函数
 * @param {Window} deps.windowRef - window 对象
 * @returns {object} 预览索引管理器
 */
export function createPreviewIndexManager({ scheduleSave, windowRef }) {
    const pendingPreviewIndexSaveNodeIds = new Set();
    let previewIndexSaveTimer = null;

    /**
     * 获取图片预览节点的当前预览索引
     * @param {object} node - 节点对象
     * @param {Array} images - 图片列表
     * @returns {number} 当前预览索引
     */
    function getImagePreviewIndex(node, images) {
        if (!images.length) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
    }

    /**
     * 获取图片保存节点的当前预览索引
     * @param {object} node - 节点对象
     * @param {Array} images - 图片列表
     * @returns {number} 当前预览索引
     */
    function getImageSavePreviewIndex(node, images) {
        if (!images.length) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
    }

    /**
     * 调度预览索引保存（防抖）
     * @param {string} nodeId - 节点ID
     */
    function schedulePreviewIndexSave(nodeId) {
        if (nodeId) pendingPreviewIndexSaveNodeIds.add(nodeId);
        if (previewIndexSaveTimer) windowRef.clearTimeout(previewIndexSaveTimer);
        previewIndexSaveTimer = windowRef.setTimeout(() => {
            previewIndexSaveTimer = null;
            pendingPreviewIndexSaveNodeIds.clear();
            scheduleSave();
        }, 800);
    }

    return {
        getImagePreviewIndex,
        getImageSavePreviewIndex,
        schedulePreviewIndexSave
    };
}
