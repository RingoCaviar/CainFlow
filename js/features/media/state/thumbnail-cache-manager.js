/**
 * 缩略图缓存管理模块
 * 管理节点预览缩略图的缓存和持久化
 */

import { isInlineImageData } from '../utils/image-validation-utils.js';

/**
 * 创建缩略图缓存管理器
 * @param {object} deps - 依赖项
 * @param {object} deps.previewCache - 预览缓存对象
 * @param {Function} deps.estimateDataUrlSize - 估算 data URL 大小的函数
 * @param {number} deps.PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH - 持久化缩略图的最大长度
 * @param {Function} deps.getNodeById - 获取节点的函数
 * @param {Function} deps.scheduleSave - 调度保存的函数
 * @returns {object} 缩略图缓存管理器
 */
export function createThumbnailCacheManager({
    previewCache,
    estimateDataUrlSize,
    PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH,
    getNodeById,
    scheduleSave
}) {
    /**
     * 选择要持久化的预览缩略图
     * @param {string} source - 原始图片源
     * @param {string} thumbnail - 缩略图
     * @returns {string} 选中的缩略图（可能为空）
     */
    function choosePersistedPreviewThumbnail(source, thumbnail) {
        const normalizedSource = typeof source === 'string' ? source.trim() : '';
        const normalizedThumbnail = typeof thumbnail === 'string' ? thumbnail.trim() : '';
        if (normalizedThumbnail && normalizedThumbnail !== normalizedSource) {
            return normalizedThumbnail;
        }
        if (normalizedSource && normalizedSource.length <= PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH) {
            return normalizedSource;
        }
        return '';
    }

    /**
     * 设置节点的预览缩略图值
     * @param {object} node - 节点对象
     * @param {string} source - 原始图片源
     * @param {string} thumbnail - 缩略图
     * @returns {string} 设置的缩略图值
     */
    function setNodePreviewThumbnailValue(node, source, thumbnail = '') {
        if (!node?.data) return '';
        const nextThumbnail = choosePersistedPreviewThumbnail(source, thumbnail);
        if (nextThumbnail) {
            node.data.imagePreviewThumbnail = nextThumbnail;
        } else {
            delete node.data.imagePreviewThumbnail;
        }
        return nextThumbnail;
    }

    /**
     * 清除节点的预览缩略图
     * @param {string|object} nodeOrId - 节点ID或节点对象
     * @returns {boolean} 是否清除成功
     */
    function clearNodePreviewThumbnail(nodeOrId) {
        const node = typeof nodeOrId === 'string' ? getNodeById(nodeOrId) : nodeOrId;
        if (!node?.data?.imagePreviewThumbnail) return false;
        delete node.data.imagePreviewThumbnail;
        return true;
    }

    /**
     * 缓存节点的预览缩略图
     * @param {string|object} nodeOrId - 节点ID或节点对象
     * @param {string} source - 原始图片源
     * @returns {Promise<string>} 缓存的缩略图
     */
    function cacheNodePreviewThumbnail(nodeOrId, source) {
        const node = typeof nodeOrId === 'string' ? getNodeById(nodeOrId) : nodeOrId;
        const normalizedSource = typeof source === 'string' ? source.trim() : '';
        if (!node?.data) return Promise.resolve('');
        if (!isInlineImageData(normalizedSource)) {
            clearNodePreviewThumbnail(node);
            return Promise.resolve('');
        }

        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        node.previewThumbnailToken = token;
        const previousThumbnail = typeof node.data?.imagePreviewThumbnail === 'string' ? node.data.imagePreviewThumbnail : '';

        return Promise.resolve(previewCache.createPreviewThumbnail(normalizedSource))
            .then((thumbnail) => {
                const latestNode = getNodeById(node.id);
                if (!latestNode || latestNode !== node || latestNode.previewThumbnailToken !== token) {
                    return '';
                }
                const nextThumbnail = setNodePreviewThumbnailValue(latestNode, normalizedSource, thumbnail);
                if (nextThumbnail !== previousThumbnail) {
                    scheduleSave();
                }
                return nextThumbnail;
            })
            .catch(() => {
                const latestNode = getNodeById(node.id);
                if (!latestNode || latestNode !== node || latestNode.previewThumbnailToken !== token) {
                    return '';
                }
                const nextThumbnail = setNodePreviewThumbnailValue(latestNode, normalizedSource, '');
                if (nextThumbnail !== previousThumbnail) scheduleSave();
                return nextThumbnail;
            });
    }

    return {
        cacheNodePreviewThumbnail,
        clearNodePreviewThumbnail,
        choosePersistedPreviewThumbnail
    };
}
