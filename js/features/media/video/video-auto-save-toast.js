/**
 * 视频自动保存进度 Toast 管理模块
 * 创建和更新视频自动保存时的进度提示
 */

import { formatProgressBytes, formatProgressSpeed } from '../utils/format-utils.js';

/**
 * 创建视频自动保存 Toast 管理器
 * @param {object} deps - 依赖项
 * @param {Document} deps.documentRef - document 对象
 * @param {Window} deps.windowRef - window 对象
 * @param {Function} deps.showToast - 显示 Toast 的函数
 * @returns {object} Toast 管理器
 */
export function createVideoAutoSaveToastManager({ documentRef, windowRef, showToast }) {
    const videoAutoSaveToasts = new Map();

    /**
     * 获取视频自动保存 Toast 记录
     * @param {string} nodeId - 节点ID
     * @returns {object|null} Toast 记录
     */
    function get(nodeId) {
        return videoAutoSaveToasts.get(nodeId) || null;
    }

    /**
     * 移除视频自动保存 Toast
     * @param {string} nodeId - 节点ID
     */
    function remove(nodeId) {
        const record = get(nodeId);
        if (!record) return;
        record.toastHandle?.dismiss?.(0);
        videoAutoSaveToasts.delete(nodeId);
    }

    /**
     * 确保视频自动保存 Toast 存在
     * @param {string} nodeId - 节点ID
     * @param {string} subtitleText - 副标题文本
     * @returns {object|null} Toast 记录
     */
    function ensure(nodeId, subtitleText = '正在自动保存视频...') {
        const existing = get(nodeId);
        if (existing?.toastHandle?.element?.isConnected) return existing;

        const toastHandle = showToast('正在自动保存视频...', 'info', 0);
        const toastEl = toastHandle?.element;
        if (!toastEl) return null;

        toastHandle.clearTimer?.();
        toastEl.className = 'toast info update-download-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        toastEl.innerHTML = '';

        // 创建 Header
        const header = documentRef.createElement('div');
        header.className = 'update-download-toast__header';

        const titleWrap = documentRef.createElement('div');
        titleWrap.className = 'update-download-toast__title-wrap';

        const title = documentRef.createElement('div');
        title.className = 'update-download-toast__title';
        title.textContent = '视频自动保存';
        titleWrap.appendChild(title);

        const subtitle = documentRef.createElement('div');
        subtitle.className = 'update-download-toast__subtitle';
        subtitle.textContent = subtitleText;
        titleWrap.appendChild(subtitle);
        header.appendChild(titleWrap);
        toastEl.appendChild(header);

        // 创建进度条
        const progress = documentRef.createElement('div');
        progress.className = 'update-download-progress update-download-progress--toast';

        const row = documentRef.createElement('div');
        row.className = 'update-download-progress__row';

        const rowTitle = documentRef.createElement('span');
        rowTitle.className = 'update-download-progress__title';
        rowTitle.textContent = '后端下载中';
        row.appendChild(rowTitle);

        const percentText = documentRef.createElement('span');
        percentText.className = 'update-download-progress__percent';
        percentText.textContent = '计算中';
        row.appendChild(percentText);
        progress.appendChild(row);

        const track = documentRef.createElement('div');
        track.className = 'update-download-progress__track is-indeterminate';

        const bar = documentRef.createElement('div');
        bar.className = 'update-download-progress__bar';
        track.appendChild(bar);
        progress.appendChild(track);

        const detail = documentRef.createElement('div');
        detail.className = 'update-download-progress__detail';

        const sizeText = documentRef.createElement('span');
        sizeText.textContent = '等待服务器返回大小...';
        detail.appendChild(sizeText);

        const statusText = documentRef.createElement('span');
        statusText.textContent = '准备中';
        detail.appendChild(statusText);

        const speedText = documentRef.createElement('span');
        speedText.textContent = '速度：等待数据';
        detail.appendChild(speedText);
        progress.appendChild(detail);

        toastEl.appendChild(progress);

        const record = {
            toastHandle,
            toastEl,
            subtitle,
            rowTitle,
            percentText,
            track,
            bar,
            sizeText,
            statusText,
            speedText
        };
        videoAutoSaveToasts.set(nodeId, record);
        return record;
    }

    /**
     * 更新视频自动保存 Toast 进度
     * @param {string} nodeId - 节点ID
     * @param {object} state - 进度状态
     * @param {string} state.subtitle - 副标题
     * @param {string} state.stage - 阶段名称
     * @param {number} state.loaded - 已下载字节数
     * @param {number} state.total - 总字节数
     * @param {string} state.status - 状态文本
     * @param {number} state.speedBytesPerSecond - 下载速度（字节/秒）
     */
    function update(nodeId, {
        subtitle = '正在自动保存视频...',
        stage = '后端下载中',
        loaded = 0,
        total = 0,
        status = '下载中',
        speedBytesPerSecond = 0
    } = {}) {
        const record = ensure(nodeId, subtitle);
        if (!record) return;

        const hasTotal = Number.isFinite(total) && total > 0;
        const safeLoaded = Math.max(0, Number(loaded) || 0);
        const percent = hasTotal ? Math.max(0, Math.min(100, (safeLoaded / total) * 100)) : null;

        record.subtitle.textContent = subtitle;
        record.rowTitle.textContent = stage;
        record.percentText.textContent = percent === null
            ? '计算中'
            : `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
        record.track.classList.toggle('is-indeterminate', percent === null);
        record.bar.style.width = percent === null ? '' : `${percent}%`;
        record.sizeText.textContent = hasTotal
            ? `${formatProgressBytes(safeLoaded)} / ${formatProgressBytes(total)}`
            : `${formatProgressBytes(safeLoaded)} / 未知大小`;
        record.statusText.textContent = status;
        record.speedText.textContent = status === '已完成'
            ? '速度：完成'
            : `速度：${formatProgressSpeed(speedBytesPerSecond)}`;
    }

    /**
     * 标记视频自动保存 Toast 为完成状态
     * @param {string} nodeId - 节点ID
     * @param {string} message - 完成消息
     */
    function complete(nodeId, message = '视频已自动保存到目录') {
        const record = ensure(nodeId, message);
        if (!record) return;
        record.toastEl.className = 'toast success update-download-toast is-completed';
        record.subtitle.textContent = message;
        record.rowTitle.textContent = '保存完成';
        record.percentText.textContent = '100%';
        record.track.classList.remove('is-indeterminate');
        record.bar.style.width = '100%';
        record.statusText.textContent = '已完成';
        record.speedText.textContent = '速度：完成';
        windowRef.setTimeout(() => remove(nodeId), 2600);
    }

    /**
     * 标记视频自动保存 Toast 为失败状态
     * @param {string} nodeId - 节点ID
     * @param {string} message - 失败消息
     */
    function fail(nodeId, message = '视频自动保存失败') {
        const record = ensure(nodeId, message);
        if (!record) return;
        record.toastEl.className = 'toast error update-download-toast';
        record.subtitle.textContent = message;
        record.rowTitle.textContent = '保存失败';
        record.statusText.textContent = '失败';
        record.speedText.textContent = '速度：失败';
        windowRef.setTimeout(() => remove(nodeId), 4000);
    }

    return {
        ensure,
        update,
        complete,
        fail,
        get,
        remove
    };
}
