/**
 * 视频下载功能模块
 * 处理视频文件的后端代理下载和流式下载
 */

import { formatProgressBytes, formatProgressSpeed } from '../utils/format-utils.js';

/**
 * 检查 Blob 是否看起来像视频文件（通过检查文件头）
 * @param {Blob} blob - Blob 对象
 * @returns {Promise<boolean>} 是否是视频文件
 */
export async function blobLooksLikeVideo(blob) {
    if (!blob || typeof blob.slice !== 'function') return false;
    const headerBlob = blob.slice(0, 64);
    const buffer = await headerBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // MP4/M4V/MOV 等（ftyp box）
    if (bytes.length >= 8 &&
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70) {
        return true;
    }

    // WebM/MKV（EBML header）
    if (bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3) {
        return true;
    }

    // AVI（RIFF header with AVI ）
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x41 &&
        bytes[9] === 0x56 &&
        bytes[10] === 0x49 &&
        bytes[11] === 0x20) {
        return true;
    }

    return false;
}

/**
 * 检查 URL 是否看起来像可下载的视频链接
 * @param {string} videoUrl - 视频 URL
 * @param {Window} windowRef - window 对象
 * @returns {boolean} 是否是可下载视频链接
 */
export function isLikelyDownloadableVideoUrl(videoUrl = '', windowRef = window) {
    const value = String(videoUrl || '').trim();
    if (!value) return false;
    try {
        const parsed = new URL(value, windowRef.location?.href || 'http://localhost');
        const pathname = String(parsed.pathname || '').toLowerCase();
        if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].some((ext) => pathname.endsWith(ext))) {
            return true;
        }
        const query = String(parsed.search || '');
        if (query.includes('Signature=') || query.includes('Expires=') || query.includes('response-content-disposition=')) {
            return true;
        }
        const host = String(parsed.hostname || '').toLowerCase();
        if (host.includes('flow-content.google') || host.includes('storage.googleapis.com')) {
            return true;
        }
    } catch (_) {
        return false;
    }
    return false;
}

/**
 * 分类视频 URL 类型（用于日志记录）
 * @param {string} videoUrl - 视频 URL
 * @param {Window} windowRef - window 对象
 * @returns {{kind: string, label: string}} URL 类型和标签
 */
export function classifyVideoUrlForLog(videoUrl = '', windowRef = window) {
    const value = String(videoUrl || '').trim();
    if (!value) return { kind: 'empty', label: '空链接' };
    return isLikelyDownloadableVideoUrl(value, windowRef)
        ? { kind: 'signed-video-direct', label: '签名视频直链' }
        : { kind: 'normal-video-url', label: '普通视频链接' };
}

/**
 * 构建后端视频下载 URL
 * @param {string} videoUrl - 原始视频 URL
 * @param {string} filenameBase - 文件名基础部分（不含扩展名）
 * @returns {string} 后端代理下载 URL
 */
export function buildBackendVideoDownloadUrl(videoUrl, filenameBase) {
    const params = new URLSearchParams();
    params.set('url', String(videoUrl || '').trim());
    if (filenameBase) params.set('filename', filenameBase);
    return `/api/media/download?${params.toString()}`;
}

/**
 * 下载生成的视频（通过后端代理）
 * @param {string} videoUrl - 视频 URL
 * @param {object} options - 选项
 * @param {string} options.filenameBase - 文件名基础部分
 * @param {Function} options.onProgress - 进度回调
 * @param {AbortSignal} options.signal - 取消信号
 * @param {Function} fetchRef - fetch 函数
 * @param {Function} formatProxyErrorMessage - 格式化代理错误消息的函数
 * @param {Function} addLog - 日志记录函数
 * @param {Window} windowRef - window 对象
 * @returns {Promise<Blob>} 视频 Blob
 */
export async function downloadGeneratedVideo(videoUrl, options = {}, { fetchRef, formatProxyErrorMessage, addLog, windowRef }) {
    const {
        filenameBase = '',
        onProgress = null,
        signal = null
    } = options;

    const backendUrl = buildBackendVideoDownloadUrl(videoUrl, filenameBase);
    const videoUrlMeta = classifyVideoUrlForLog(videoUrl, windowRef);
    let response = null;
    let postErrorMessage = '';

    // 尝试 POST 方式下载
    try {
        response = await fetchRef('/api/media/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'video/*,application/octet-stream'
            },
            signal,
            body: JSON.stringify({
                url: String(videoUrl || '').trim(),
                filename: filenameBase || ''
            })
        });
        if (!response.ok) {
            const bodyText = await response.text();
            postErrorMessage = typeof formatProxyErrorMessage === 'function'
                ? formatProxyErrorMessage(response.status, bodyText, '后端视频下载失败')
                : `后端视频下载失败 (${response.status})`;
            addLog('warning', '后端视频下载失败', postErrorMessage, {
                method: 'POST',
                url: '/api/media/download',
                sourceVideoUrl: videoUrl,
                videoUrlType: videoUrlMeta.kind,
                videoUrlLabel: videoUrlMeta.label,
                filenameBase
            });
            response = null;
        }
    } catch (error) {
        postErrorMessage = error?.message || String(error);
        addLog('warning', '后端视频下载异常', postErrorMessage, {
            method: 'POST',
            url: '/api/media/download',
            sourceVideoUrl: videoUrl,
            videoUrlType: videoUrlMeta.kind,
            videoUrlLabel: videoUrlMeta.label,
            filenameBase
        });
        response = null;
    }

    // 如果 POST 失败，回退到 GET 方式
    if (!response) {
        response = await fetchRef(backendUrl, {
            method: 'GET',
            headers: {
                Accept: 'video/*,application/octet-stream'
            },
            signal
        });
        if (!response.ok) {
            const bodyText = await response.text();
            const getErrorMessage = typeof formatProxyErrorMessage === 'function'
                ? formatProxyErrorMessage(response.status, bodyText, '后端视频下载失败')
                : `后端视频下载失败 (${response.status})`;
            addLog('warning', '后端视频下载回退失败', getErrorMessage, {
                method: 'GET',
                url: backendUrl,
                sourceVideoUrl: videoUrl,
                videoUrlType: videoUrlMeta.kind,
                videoUrlLabel: videoUrlMeta.label,
                previousError: postErrorMessage
            });
            throw new Error(postErrorMessage
                ? `${postErrorMessage}；GET 回退也失败：${getErrorMessage}`
                : getErrorMessage);
        }
    }

    // 验证 Content-Type
    const responseContentType = String(response.headers.get('Content-Type') || '').toLowerCase();
    const allowNonStandardVideoContentType = isLikelyDownloadableVideoUrl(videoUrl, windowRef);
    if (!responseContentType.startsWith('video/') && !allowNonStandardVideoContentType) {
        const invalidBody = await response.text();
        addLog('warning', '后端视频下载返回了非视频内容', '后端返回的不是视频文件，已阻止写入保存目录。', {
            sourceVideoUrl: videoUrl,
            videoUrlType: videoUrlMeta.kind,
            videoUrlLabel: videoUrlMeta.label,
            contentType: responseContentType || 'unknown',
            body: invalidBody
        });
        throw new Error(`后端返回的不是视频文件 (${responseContentType || 'unknown'})`);
    }

    const total = Number(response.headers.get('Content-Length') || 0);
    const downloadStartedAt = Date.now();
    const getAverageSpeed = (loadedBytes) => {
        const elapsedSeconds = Math.max(0.001, (Date.now() - downloadStartedAt) / 1000);
        return Math.round((Number(loadedBytes) || 0) / elapsedSeconds);
    };

    // 如果不支持流式读取，直接下载整个 Blob
    if (!response.body || typeof response.body.getReader !== 'function') {
        const blob = await response.blob();
        if (!String(blob.type || '').toLowerCase().startsWith('video/') && !allowNonStandardVideoContentType) {
            throw new Error(`下载结果不是视频文件 (${blob.type || 'unknown'})`);
        }
        if (blob.size < 1024) {
            throw new Error(`下载结果大小异常 (${blob.size} B)，已阻止保存`);
        }
        if (!(await blobLooksLikeVideo(blob))) {
            throw new Error('下载结果文件头不是有效视频，已阻止保存');
        }
        if (typeof onProgress === 'function') {
            onProgress({
                loaded: blob.size || total || 0,
                total: total || blob.size || 0,
                speedBytesPerSecond: getAverageSpeed(blob.size || total || 0),
                done: true
            });
        }
        return blob;
    }

    // 流式下载
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (typeof onProgress === 'function') {
            onProgress({
                loaded,
                total,
                speedBytesPerSecond: getAverageSpeed(loaded),
                done: false
            });
        }
    }

    const blob = new Blob(chunks, { type: responseContentType || 'video/mp4' });
    if (blob.size < 1024) {
        throw new Error(`下载结果大小异常 (${blob.size} B)，已阻止保存`);
    }
    if (!(await blobLooksLikeVideo(blob))) {
        throw new Error('下载结果文件头不是有效视频，已阻止保存');
    }
    if (typeof onProgress === 'function') {
        onProgress({
            loaded: blob.size,
            total: blob.size,
            speedBytesPerSecond: getAverageSpeed(blob.size),
            done: true
        });
    }
    return blob;
}
