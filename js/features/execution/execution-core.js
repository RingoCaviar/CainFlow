/**
 * 提供工作流执行所需的核心能力，包括拓扑排序、节点执行和运行时错误处理。
 */
import {
    buildGoogleChatRequest,
    buildGoogleImageRequest,
    buildOpenAiChatRequest,
    buildOpenAiImageRequest,
    buildDoubaoVideoRequest,
    buildOpenAiVideoRequest,
    buildUnifiedVideoRequest,
    extractImageResult,
    extractVideoResult,
    extractVideoStatus,
    extractVideoTaskId,
    getEffectiveProtocol,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    resolveProviderUrl,
    validateOpenAiImageSize
} from './provider-request-utils.js';
import {
    getPrimaryImageInput,
    getLastImageInput,
    getPrimaryTextInput,
    getTextInputList,
    normalizeImageList
} from './execution-data-utils.js';
import { escapeHtml, splitTextForTextSplitNode } from '../../core/common-utils.js';
import { generateCameraPrompt } from '../camera/camera-control-node.js';

export function createExecutionCoreApi({
    state,
    nodeConfigs,
    syncTextSplitNodeData = () => {},
    documentRef = document,
    windowRef = window,
    fetchRef = fetch,
    showToast,
    addLog,
    getProxyHeaders,
    classifyProviderError,
    logRequestToPanel,
    formatProxyErrorMessage,
    saveHistoryEntry,
    renderHistoryList,
    showResolutionBadge,
    saveImageAsset,
    saveImageAssetList = async () => false,
    deleteImageAsset,
    dataURLtoBlob,
    blobToDataUrl,
    resizeImageData,
    autoSaveToDir,
    restoreImageResizePreview,
    refreshDependentImageResizePreviews,
    syncImagePreviewNode = async () => {},
    syncImageSaveNode = async () => {},
    syncImageCompareNode,
    syncCameraControlNode = () => '',
    fitNodeToContent,
    scheduleSave = () => {},
    getAbortMessage,
    updateAllConnections,
    getImageHistorySidebarActive = () => false
}) {
    function requestNodeFit(nodeId) {
        windowRef.requestAnimationFrame(() => {
            fitNodeToContent(nodeId);
        });
    }

    function updateVideoGenerationStatus(nodeId, text, state = 'progress') {
        const statusEl = documentRef.getElementById(`${nodeId}-video-status`);
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = `video-generation-status video-generation-status-${state}`;
        requestNodeFit(nodeId);
    }

    function renderApiGenerationProgressState(nodeId, {
        current = 0,
        total = 1
    } = {}) {
        const progressEl = documentRef.getElementById(`${nodeId}-generation-progress`);
        if (!progressEl) return;

        const safeTotal = Math.max(1, parseInt(total, 10) || 1);
        const safeCurrent = Math.max(0, Math.min(safeTotal, parseInt(current, 10) || 0));
        progressEl.textContent = `${safeCurrent}/${safeTotal}`;
        progressEl.dataset.total = String(safeTotal);
        progressEl.classList.remove('hidden');

        requestNodeFit(nodeId);
    }

    function renderNodeApiGenerationProgress(node, fallback = {}) {
        const runtimeProgress = node?.apiGenerationProgress;
        if (runtimeProgress) {
            renderApiGenerationProgressState(node.id, {
                current: runtimeProgress.completed,
                total: runtimeProgress.total
            });
            return;
        }

        renderApiGenerationProgressState(node.id, fallback);
    }

    function incrementNodeApiGenerationProgress(node, amount = 1, fallback = {}) {
        if (!node) return;
        const fallbackCompleted = fallback.current ?? fallback.completed;
        const runtimeProgress = node.apiGenerationProgress || {
            completed: fallbackCompleted === undefined
                ? 0
                : Math.max(0, (parseInt(fallbackCompleted, 10) || 0) - amount),
            total: Math.max(1, parseInt(fallback.total ?? amount, 10) || 1)
        };
        const total = Math.max(1, parseInt(runtimeProgress.total, 10) || 1);
        const completed = Math.max(0, Math.min(total, (parseInt(runtimeProgress.completed, 10) || 0) + amount));
        node.apiGenerationProgress = {
            ...runtimeProgress,
            total,
            completed
        };
        renderApiGenerationProgressState(node.id, { current: completed, total });
    }

    function completeNodeApiGenerationProgress(node, fallback = { current: 1, total: 1 }) {
        const runtimeProgress = node?.apiGenerationProgress;
        if (!runtimeProgress) {
            renderApiGenerationProgressState(node.id, fallback);
            return;
        }
        const total = Math.max(1, parseInt(runtimeProgress.total, 10) || 1);
        node.apiGenerationProgress = {
            ...runtimeProgress,
            total,
            completed: total
        };
        renderApiGenerationProgressState(node.id, { current: total, total });
    }

    function getConcurrentRequestRetryLimit() {
        if (state.autoRetry !== true) return 0;
        const retries = Number.parseInt(state.maxRetries, 10);
        return Number.isFinite(retries) && retries > 0 ? retries : 0;
    }

    function isConcurrentRequestModeEnabled() {
        return state.concurrentRequestMode === true;
    }

    function isRetryableRequestError(error) {
        if (error?.serverResponse) return true;
        if (error?.name === 'TypeError') return true;
        const message = String(error?.message || '').toLowerCase();
        return /failed to fetch|networkerror|timeout|timed out|download|下载|超时/.test(message);
    }

    async function runRequestWithRetries(requestFn, {
        label,
        signal,
        onRetry = () => {}
    } = {}) {
        const maxRetries = getConcurrentRequestRetryLimit();
        let attempt = 0;
        while (true) {
            if (signal?.aborted) {
                const abortError = new Error('Node run aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }
            try {
                return await requestFn({ attempt });
            } catch (error) {
                if (isAbortLikeError(error, signal)) throw error;
                if (!isRetryableRequestError(error)) throw error;
                if (attempt >= maxRetries) throw error;
                attempt += 1;
                onRetry(attempt, error);
                addLog('warning', `${label} 重试`, `第 ${attempt} 次重试即将开始。`, {
                    error: error?.message || String(error)
                });
            }
        }
    }

    function commitImageGenerateOutputs(node, images = [], prompt = '') {
        const normalizedImages = normalizeImageList(images);
        node.data = node.data || {};
        if (normalizedImages.length > 0) {
            node.data.images = normalizedImages.slice();
            node.data.image = normalizedImages[normalizedImages.length - 1];
            node.data.imagePromptList = normalizedImages.map(() => prompt || '');
        } else {
            delete node.data.images;
            delete node.data.image;
            delete node.data.imagePromptList;
        }
        node.imageDataList = normalizedImages.slice();
        node.imageData = normalizedImages[normalizedImages.length - 1] || null;
        node.generatedImages = normalizedImages.slice();
        node.imagePromptList = normalizedImages.map(() => prompt || '');
        node.generationCompletedCount = normalizedImages.length;
        if (normalizedImages.length > 1) {
            void saveImageAssetList(node.id, normalizedImages);
        } else if (normalizedImages.length === 1) {
            void saveImageAsset(node.id, normalizedImages[0]);
        } else if (deleteImageAsset) {
            void deleteImageAsset(node.id);
        }
    }

    function commitVideoGenerateOutputs(node, payload = {}) {
        node.data = node.data || {};
        if (Object.prototype.hasOwnProperty.call(payload, 'videoId')) node.data.videoId = payload.videoId || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'videoUrl')) node.data.videoUrl = payload.videoUrl || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'status')) node.data.videoStatus = payload.status || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'statusText')) node.data.videoStatusText = payload.statusText || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'prompt')) node.data.prompt = payload.prompt || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'createHttpStatus')) node.data.videoCreateHttpStatus = payload.createHttpStatus || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'createStatus')) node.data.videoCreateStatus = payload.createStatus || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'statusUpdateTime')) node.data.videoStatusUpdateTime = payload.statusUpdateTime || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'enhancedPrompt')) node.data.videoEnhancedPrompt = payload.enhancedPrompt || '';

        const videoId = node.data.videoId || '';
        const videoUrl = node.data.videoUrl || '';
        const status = node.data.videoStatus || '';
        const prompt = node.data.prompt || '';
        if (videoUrl) {
            node.data.video = {
                id: videoId,
                url: videoUrl,
                status,
                prompt
            };
        } else {
            delete node.data.video;
        }

        const resumeIdInput = documentRef.getElementById(`${node.id}-resume-video-id`);
        if (resumeIdInput) resumeIdInput.value = videoId;
        const resumeBtn = documentRef.getElementById(`${node.id}-resume-video`);
        if (resumeBtn) resumeBtn.disabled = !String(videoId || '').trim();
    }

    function getVideoCreateResponseSummary(result = {}, fallbackVideoId = '') {
        const videoId = String(result?.id || result?.data?.id || fallbackVideoId || '').trim();
        const status = String(result?.status || result?.data?.status || '').trim();
        const statusUpdateTime = String(result?.status_update_time || result?.data?.status_update_time || '').trim();
        const enhancedPrompt = String(result?.enhanced_prompt || result?.data?.enhanced_prompt || '').trim();
        return {
            videoId,
            status,
            statusUpdateTime,
            enhancedPrompt
        };
    }

    function buildVideoCreateResponseHtml({
        httpStatus = '',
        videoId = '',
        status = '',
        statusUpdateTime = '',
        enhancedPrompt = ''
    } = {}) {
        const lines = [];
        if (httpStatus !== '') lines.push(`<div><strong>HTTP 状态：</strong>${escapeHtml(String(httpStatus))}</div>`);
        if (videoId) lines.push(`<div><strong>任务 ID：</strong>${escapeHtml(videoId)}</div>`);
        if (status) lines.push(`<div><strong>创建状态：</strong>${escapeHtml(status)}</div>`);
        if (statusUpdateTime) lines.push(`<div><strong>状态更新时间：</strong>${escapeHtml(statusUpdateTime)}</div>`);
        if (enhancedPrompt) lines.push(`<div><strong>增强提示词：</strong>${escapeHtml(enhancedPrompt)}</div>`);
        if (!lines.length) {
            return '<div class="chat-response-placeholder">任务已创建，等待服务器返回更多信息...</div>';
        }
        return `<div><strong>视频创建响应</strong></div>${lines.join('')}<div style="margin-top:6px;color:var(--text-dim);">创建完成后将继续自动轮询视频状态。</div>`;
    }

    async function saveImageGenerationHistoryEntry(entry) {
        try {
            const saved = await saveHistoryEntry(entry);
            if (saved === false) {
                addLog('warning', '生成历史保存失败', '图片已经生成成功，但写入历史记录失败。通常是图片过大、浏览器存储空间不足，或 IndexedDB 暂时不可用。', {
                    nodeId: entry?.nodeId,
                    model: entry?.model
                });
            }
        } catch (error) {
            addLog('warning', '生成历史保存异常', '图片已经生成成功，但保存历史记录时发生异常，不影响本次生成结果继续传递到下游。', {
                nodeId: entry?.nodeId,
                model: entry?.model,
                error: error?.message || String(error)
            });
        }
    }

    function getNodeGenerationDurationSeconds(node) {
        if (Number.isFinite(node?.runStartedAt) && node.runStartedAt > 0) {
            return Number(((Date.now() - node.runStartedAt) / 1000).toFixed(2));
        }
        const duration = Number.parseFloat(node?.lastDuration);
        return Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(2)) : null;
    }

    function isAbortLikeError(err, signal) {
        if (!err) return Boolean(signal?.aborted);
        if (signal?.aborted) return true;
        if (err.name === 'AbortError') return true;
        if (typeof err.message === 'string' && err.message.toLowerCase().includes('aborted')) return true;
        return false;
    }

    function getApiKeyShape(apiKey) {
        const key = String(apiKey || '').trim();
        if (!key) return 'empty';
        if (key.startsWith('sk-')) return 'openai_like';
        if (key.startsWith('AIza')) return 'google_like';
        return 'unknown';
    }

    function buildProviderErrorContext(apiCfg, modelCfg, url) {
        const protocol = getEffectiveProtocol(modelCfg, apiCfg);
        return {
            providerType: protocol || 'unknown',
            url,
            modelId: modelCfg?.modelId || '',
            providerId: apiCfg?.id || '',
            apiKeyShape: getApiKeyShape(apiCfg?.apikey)
        };
    }

    function applyUserFacingError(err, userFacing) {
        if (!err || !userFacing) return err;
        err.userFacing = userFacing;
        if (userFacing.userMessage) err.message = userFacing.userMessage;
        return err;
    }

    async function parseJsonResponseOrThrow(response, context = {}) {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const rawText = await response.text();
        if (context && typeof context === 'object') {
            context.__rawResponseText = rawText;
            context.__responseContentType = contentType;
        }
        const trimmedText = rawText.trim();

        const isHtmlResponse = contentType.includes('text/html') || /^<!doctype html/i.test(trimmedText) || /^<html/i.test(trimmedText);
        if (isHtmlResponse) {
            const err = new Error('当前提供商返回的是网页 HTML，而不是 API JSON。请检查 API 地址是否填成了网站首页，而不是接口地址。');
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            applyUserFacingError(err, {
                title: 'API 地址配置错误',
                userMessage: '当前提供商返回的是网页 HTML，不是 API JSON。通常是 API 地址填成了网站首页，或缺少 `/v1` 之类的接口前缀。',
                suggestions: [
                    '检查提供商的 API 地址是否为文档中的接口基址，而不是官网首页。',
                    '如果你在使用 OpenAI 兼容提供商，优先确认地址是否应以 `/v1` 结尾。',
                    '把当前地址复制到浏览器访问，如果看到网页后台而不是接口响应，通常就是地址填错了。'
                ],
                category: 'html_instead_of_json',
                providerType: getEffectiveProtocol(context.modelCfg, context.apiCfg) || 'unknown',
                rawMessage: 'HTML page returned instead of API JSON.'
            });
            throw err;
        }

        if (!trimmedText) {
            const err = new Error('API 返回了空响应，未收到有效 JSON 数据。');
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            throw err;
        }

        try {
            return JSON.parse(trimmedText);
        } catch {
            const err = new Error('当前提供商返回的不是有效 JSON，请检查接口兼容性或 API 地址。');
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            applyUserFacingError(err, {
                title: '响应格式不兼容',
                userMessage: '当前提供商返回的内容不是可解析的 JSON，可能是接口地址不对，或该服务并不兼容当前请求协议。',
                suggestions: [
                    '检查当前 endpoint 是否正确。',
                    '确认这个提供商是否真的兼容当前所选模型和协议。',
                    '如果服务商文档有示例请求，建议对照检查路径和请求格式。'
                ],
                category: 'invalid_json_response',
                providerType: getEffectiveProtocol(context.modelCfg, context.apiCfg) || 'unknown',
                rawMessage: trimmedText.slice(0, 200)
            });
            throw err;
        }
    }

    async function responseToImageBlob(response, sourceLabel, parseProxyError = false) {
        if (!response.ok) {
            const bodyText = await response.text();
            const message = parseProxyError
                ? formatProxyErrorMessage(response.status, bodyText, `${sourceLabel}失败`)
                : `${sourceLabel}失败 (${response.status})`;
            throw new Error(message);
        }

        const blob = await response.blob();
        if (!blob || (blob.type && !blob.type.startsWith('image/'))) {
            throw new Error(`${sourceLabel} 返回的内容不是图片`);
        }
        return blob;
    }

    function ensureImageBlobType(blob, imgUrl) {
        if (!blob || blob.type) return blob;

        const normalizedUrl = String(imgUrl || '').toLowerCase();
        if (normalizedUrl.includes('.jpg') || normalizedUrl.includes('.jpeg')) {
            return new Blob([blob], { type: 'image/jpeg' });
        }
        if (normalizedUrl.includes('.webp')) {
            return new Blob([blob], { type: 'image/webp' });
        }
        if (normalizedUrl.includes('.gif')) {
            return new Blob([blob], { type: 'image/gif' });
        }
        return new Blob([blob], { type: 'image/png' });
    }

    async function downloadGeneratedImage(imgUrl, signal) {
        let directError = null;
        try {
            const directRes = await fetchRef(imgUrl, { signal });
            const directBlob = await responseToImageBlob(directRes, '图片直连下载');
            return ensureImageBlobType(directBlob, imgUrl);
        } catch (error) {
            directError = error;
            addLog('warning', '图片直连下载失败', error.message, imgUrl);
        }

        let proxyError = null;
        try {
            const proxyHeaders = getProxyHeaders(imgUrl, 'GET', {
                Accept: 'image/*',
                'Content-Type': null
            });
            const proxyRes = await fetchRef('/proxy', {
                method: 'POST',
                headers: proxyHeaders,
                signal
            });
            const proxyBlob = await responseToImageBlob(proxyRes, '图片代理下载', true);
            return ensureImageBlobType(proxyBlob, imgUrl);
        } catch (error) {
            proxyError = error;
            addLog('warning', '图片代理下载失败', error.message, imgUrl);
        }

        const reasons = [directError?.message, proxyError?.message].filter(Boolean).join('；');
        throw new Error(`图片已生成，但下载至本地失败。${reasons ? `原因：${reasons}` : ''}`);
    }

    async function downloadGeneratedVideo(videoUrl, signal) {
        let directError = null;
        try {
            const directRes = await fetchRef(videoUrl, { signal });
            if (!directRes.ok) throw new Error(`视频直连下载失败 (${directRes.status})`);
            return await directRes.blob();
        } catch (error) {
            directError = error;
            addLog('warning', '视频直连下载失败', error.message, videoUrl);
        }

        let proxyError = null;
        try {
            const proxyHeaders = getProxyHeaders(videoUrl, 'GET', {
                Accept: 'video/*',
                'Content-Type': null
            });
            const proxyRes = await fetchRef('/proxy', {
                method: 'POST',
                headers: proxyHeaders,
                signal
            });
            if (!proxyRes.ok) {
                const bodyText = await proxyRes.text();
                throw new Error(formatProxyErrorMessage(proxyRes.status, bodyText, '视频代理下载失败'));
            }
            return await proxyRes.blob();
        } catch (error) {
            proxyError = error;
            addLog('warning', '视频代理下载失败', error.message, videoUrl);
        }

        const reasons = [directError?.message, proxyError?.message].filter(Boolean).join('；');
        throw new Error(`视频已生成，但下载失败。${reasons ? `原因：${reasons}` : ''}`);
    }

    async function pollVideoGeneration({
        apiCfg,
        modelCfg,
        protocol,
        videoId,
        signal,
        prompt
    }) {
        const maxAttempts = 180;
        const intervalMs = 5000;
        const max404Retries = 5;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (signal?.aborted) {
                const abortError = new Error('Node run aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }

            const url = resolveProviderUrl(apiCfg, modelCfg, 'video', {
                action: 'query',
                videoId
            });
            const requestBody = null;
            const headers = getProxyHeaders(url, 'GET', {
                Authorization: `Bearer ${apiCfg.apikey}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            });

            logRequestToPanel(
                `视频轮询请求: ${modelCfg.name} (${attempt}/${maxAttempts})`,
                url,
                {
                    method: 'GET',
                    query: { id: videoId },
                    pollAttempt: attempt,
                    pollIntervalMs: intervalMs
                },
                {
                    nodeType: 'VideoGenerate',
                    providerType: protocol,
                    videoId,
                    pollAttempt: attempt
                }
            );

            const response = await fetchRef('/proxy', {
                method: 'POST',
                headers,
                signal
            });

            if (!response.ok) {
                const t = await response.text();
                addLog('warning', `视频轮询响应: ${modelCfg.name} (${attempt}/${maxAttempts})`, `服务器返回错误状态 ${response.status}`, {
                    url,
                    method: 'GET',
                    status: response.status,
                    videoId,
                    pollAttempt: attempt,
                    body: t
                });
                if (protocol === 'veo-unified' && response.status === 404 && attempt < Math.min(maxAttempts, max404Retries)) {
                    await new Promise((resolve, reject) => {
                        const timer = windowRef.setTimeout(resolve, intervalMs);
                        if (signal) {
                            signal.addEventListener('abort', () => {
                                windowRef.clearTimeout(timer);
                                const abortError = new Error('Node run aborted');
                                abortError.name = 'AbortError';
                                reject(abortError);
                            }, { once: true });
                        }
                    });
                    continue;
                }
                const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                const err = new Error(formatProxyErrorMessage(response.status, t, '视频状态查询失败', errorContext));
                err.serverResponse = {
                    url,
                    requestBody,
                    status: response.status,
                    body: t
                };
                throw err;
            }

            const result = await parseJsonResponseOrThrow(response, {
                apiCfg,
                modelCfg,
                url,
                requestBody
            });
            addLog('info', `视频轮询响应: ${modelCfg.name} (${attempt}/${maxAttempts})`, '已收到服务器返回', {
                url,
                method: 'GET',
                status: response.status,
                videoId,
                pollAttempt: attempt,
                responseBody: result
            });
            const status = extractVideoStatus(result, protocol);
            const extracted = extractVideoResult(result, protocol);

            if (status === 'completed' || status === 'succeeded' || status === 'success' || extracted.url) {
                let finalUrl = extracted.url;
                if (protocol === 'veo-openai' && !finalUrl) {
                    const downloadUrl = resolveProviderUrl(apiCfg, modelCfg, 'video', {
                        action: 'download',
                        videoId
                    });
                    const blob = await downloadGeneratedVideo(downloadUrl, signal);
                    finalUrl = URL.createObjectURL(blob);
                }
                return {
                    videoId,
                    videoUrl: finalUrl,
                    status,
                    statusText: `视频生成完成（任务 ${videoId}）`,
                    prompt,
                    statusUpdateTime: String(result?.status_update_time || result?.data?.status_update_time || '').trim()
                };
            }

            if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
                throw new Error(`视频生成失败，当前状态：${status || 'unknown'}`);
            }

            await new Promise((resolve, reject) => {
                const timer = windowRef.setTimeout(resolve, intervalMs);
                if (signal) {
                    signal.addEventListener('abort', () => {
                        windowRef.clearTimeout(timer);
                        const abortError = new Error('Node run aborted');
                        abortError.name = 'AbortError';
                        reject(abortError);
                    }, { once: true });
                }
            });
        }

        throw new Error('视频生成轮询超时，请稍后在供应商后台确认任务状态');
    }

    async function resumeVideoGeneration(nodeId, signal = null) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'VideoGenerate') {
            throw new Error('未找到可恢复的视频生成节点');
        }

        const configId = documentRef.getElementById(`${nodeId}-apiconfig`)?.value || '';
        const modelCfg = state.models.find((model) => model.id === configId);
        if (!modelCfg) throw new Error('未找到选定的视频模型配置');

        const selectedProviderId = documentRef.getElementById(`${nodeId}-provider`)?.value || node.providerId || '';
        const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
        const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
        if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
        node.providerId = resolvedProviderId;

        const videoId = String(node.data?.videoId || '').trim();
        if (!videoId) throw new Error('当前节点没有可恢复的任务 ID');

        const protocol = getEffectiveProtocol(modelCfg, apiCfg);
        const prompt = String(node.data?.prompt || documentRef.getElementById(`${nodeId}-prompt`)?.value || '').trim();
        const responseArea = documentRef.getElementById(`${nodeId}-response`);
        const downloadBtn = documentRef.getElementById(`${nodeId}-download-video`);
        const resumeBtn = documentRef.getElementById(`${nodeId}-resume-video`);
        const resumeIdInput = documentRef.getElementById(`${nodeId}-resume-video-id`);
        if (resumeIdInput) resumeIdInput.value = videoId;

        renderNodeApiGenerationProgress(node, { current: 0, total: 1 });
        updateVideoGenerationStatus(nodeId, `轮询中：正在恢复任务 ${videoId} 的状态...`, 'progress');
        if (responseArea) {
            responseArea.innerHTML = `<div class="chat-response-placeholder">正在恢复任务 ${escapeHtml(videoId)} 的进度...</div>`;
        }
        if (downloadBtn) downloadBtn.disabled = true;
        if (resumeBtn) resumeBtn.disabled = true;

        try {
            const finalResult = await pollVideoGeneration({
                apiCfg,
                modelCfg,
                protocol,
                videoId,
                signal,
                prompt
            });
            commitVideoGenerateOutputs(node, finalResult);
            if (responseArea) {
                responseArea.innerHTML = finalResult.videoUrl
                    ? `${buildVideoCreateResponseHtml({
                        httpStatus: node.data?.videoCreateHttpStatus || '',
                        videoId: node.data?.videoId || videoId,
                        status: node.data?.videoCreateStatus || finalResult.status || '',
                        statusUpdateTime: finalResult.statusUpdateTime || node.data?.videoStatusUpdateTime || '',
                        enhancedPrompt: node.data?.videoEnhancedPrompt || ''
                    })}<div style="margin-top:8px;"><a href="${escapeHtml(finalResult.videoUrl)}" target="_blank" rel="noreferrer">打开视频结果</a></div><div style="margin-top:6px;">${escapeHtml(finalResult.statusText || '')}</div>`
                    : `${buildVideoCreateResponseHtml({
                        httpStatus: node.data?.videoCreateHttpStatus || '',
                        videoId: node.data?.videoId || videoId,
                        status: node.data?.videoCreateStatus || finalResult.status || '',
                        statusUpdateTime: finalResult.statusUpdateTime || node.data?.videoStatusUpdateTime || '',
                        enhancedPrompt: node.data?.videoEnhancedPrompt || ''
                    })}<div style="margin-top:6px;" class="chat-response-placeholder">${escapeHtml(finalResult.statusText || '任务已恢复')}</div>`;
            }
            updateVideoGenerationStatus(nodeId, finalResult.statusText || `已完成：任务 ${videoId} 已恢复`, 'success');
            completeNodeApiGenerationProgress(node, { current: 1, total: 1 });
            if (downloadBtn) downloadBtn.disabled = !finalResult.videoUrl;
            updateAllConnections();
            scheduleSave();
            return finalResult;
        } finally {
            if (resumeBtn) resumeBtn.disabled = false;
        }
    }

    function getImageGenerationError(apiCfg, result, modelCfg) {
        if (result?.error?.message) return `API 错误: ${result.error.message}`;

        if (getEffectiveProtocol(modelCfg, apiCfg) === 'google') {
            const candidate = result?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const hasTextOnlyResponse = parts.length > 0 && parts.every((part) => typeof part?.text === 'string' && !part?.inlineData?.data);
            if (candidate?.finishReason) {
                const finishReason = candidate.finishReason;
                if (finishReason === 'STOP' && hasTextOnlyResponse) return '模型已正常结束，但这次只返回了文本，没有返回图片。通常是当前模型或中转线路不支持图片输出，或本次请求被当成了文本生成。';
                if (finishReason === 'SAFETY') return '内容被安全过滤器拦截（可能包含违规提示词或敏感动作）';
                if (finishReason === 'RECITATION') return '生成内容由于版权保护被拦截';
                return `生成停止原因: ${finishReason}`;
            }
            const blockReason = result?.promptFeedback?.blockReason || result?.promptFeedback?.gemini_block_reason || result?.gemini_block_reason;
            if (blockReason) {
                return blockReason === 'SAFETY'
                    ? '请求因违反安全策略被系统拦截（SAFETY）'
                    : `请求被屏蔽：${blockReason}`;
            }
        }

        return 'API 未返回图片数据';
    }

    function normalizeRunOptions(runInput = null) {
        if (typeof runInput === 'string') {
            return {
                mode: 'target-node',
                targetNodeId: runInput,
                selectedNodeIds: []
            };
        }

        if (!runInput || typeof runInput !== 'object') {
            return {
                mode: 'all',
                targetNodeId: null,
                selectedNodeIds: []
            };
        }

        const selectedNodeIds = Array.isArray(runInput.selectedNodeIds)
            ? Array.from(new Set(runInput.selectedNodeIds.filter((id) => typeof id === 'string' && state.nodes.has(id))))
            : Array.from(state.selectedNodes).filter((id) => state.nodes.has(id));
        const targetNodeId = typeof runInput.targetNodeId === 'string' && state.nodes.has(runInput.targetNodeId)
            ? runInput.targetNodeId
            : null;
        const mode = runInput.mode === 'target-node' || runInput.mode === 'selected-only'
            ? runInput.mode
            : 'all';

        return {
            mode,
            targetNodeId,
            selectedNodeIds
        };
    }

    function getImageImportOutputValue(node) {
        if (!node || node.type !== 'ImageImport') return undefined;
        return node.importMode === 'url'
            ? (node.imageUrl || undefined)
            : (node.imageData || undefined);
    }

    function isFixedTextChatWithCachedResult(node) {
        if (node?.type !== 'TextChat') return false;
        const fixedToggle = documentRef.getElementById(`${node.id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        return isFixed && node.isSucceeded === true && typeof node.data?.text === 'string' && node.data.text.trim().length > 0;
    }

    function collectUpstreamNodeIds(targetNodeId) {
        if (!targetNodeId || !state.nodes.has(targetNodeId)) return null;

        const scopeNodeSet = new Set();

        function visit(nodeId) {
            if (scopeNodeSet.has(nodeId)) return;
            scopeNodeSet.add(nodeId);
            const node = state.nodes.get(nodeId);
            if (nodeId !== targetNodeId && isFixedTextChatWithCachedResult(node)) return;
            state.connections
                .filter((connection) => connection.to.nodeId === nodeId)
                .forEach((connection) => {
                    if (state.nodes.has(connection.from.nodeId)) {
                        visit(connection.from.nodeId);
                    }
                });
        }

        visit(targetNodeId);
        return scopeNodeSet;
    }

    function buildConnectionMaps(scopeNodeSet, mode, runOptions = {}) {
        const incomingConnectionsByNode = Object.create(null);
        const inputConnectionsByNode = Object.create(null);

        scopeNodeSet.forEach((nodeId) => {
            const node = state.nodes.get(nodeId);
            const useFixedCache = !(mode === 'target-node' && nodeId === runOptions.targetNodeId) &&
                isFixedTextChatWithCachedResult(node);
            const allIncoming = useFixedCache
                ? []
                : state.connections.filter((connection) => (
                    connection.to.nodeId === nodeId && state.nodes.has(connection.from.nodeId)
                ));
            inputConnectionsByNode[nodeId] = allIncoming;
            incomingConnectionsByNode[nodeId] = mode === 'selected-only'
                ? allIncoming.filter((connection) => scopeNodeSet.has(connection.from.nodeId))
                : allIncoming.filter((connection) => scopeNodeSet.has(connection.from.nodeId));
        });

        return {
            incomingConnectionsByNode,
            inputConnectionsByNode
        };
    }

    function topologicalSortForPlan(plan) {
        const visited = new Set();
        const visiting = new Set();
        const result = [];

        function visit(nodeId) {
            if (visited.has(nodeId)) return true;
            if (visiting.has(nodeId)) return false;

            visiting.add(nodeId);

            for (const connection of plan.incomingConnectionsByNode[nodeId] || []) {
                if (!visit(connection.from.nodeId)) return false;
            }

            visiting.delete(nodeId);
            visited.add(nodeId);
            result.push(nodeId);
            return true;
        }

        for (const nodeId of plan.nodeIds) {
            if (!visit(nodeId)) {
                showToast('循环连接', 'error');
                return null;
            }
        }

        return result;
    }

    function resolveExecutionPlan(runInput = null) {
        const runOptions = normalizeRunOptions(runInput);
        let scopeNodeSet = null;

        if (runOptions.mode === 'target-node') {
            if (!runOptions.targetNodeId) {
                showToast('未找到目标节点', 'error');
                return null;
            }
            scopeNodeSet = collectUpstreamNodeIds(runOptions.targetNodeId);
        } else if (runOptions.mode === 'selected-only') {
            scopeNodeSet = new Set(runOptions.selectedNodeIds);
            if (scopeNodeSet.size === 0) {
                showToast('请先选择要运行的节点', 'warning');
                return null;
            }
        } else {
            scopeNodeSet = new Set(state.nodes.keys());
        }

        if (!scopeNodeSet || scopeNodeSet.size === 0) {
            showToast('当前没有可运行的节点', 'warning');
            return null;
        }

        const nodeIds = Array.from(scopeNodeSet);
        const {
            incomingConnectionsByNode,
            inputConnectionsByNode
        } = buildConnectionMaps(scopeNodeSet, runOptions.mode, runOptions);
        const plan = {
            ...runOptions,
            nodeIds,
            scopeNodeSet,
            incomingConnectionsByNode,
            inputConnectionsByNode,
            executionOrder: []
        };
        const executionOrder = topologicalSortForPlan(plan);
        if (!executionOrder) return null;
        plan.executionOrder = executionOrder;
        return plan;
    }

    function topologicalSort(runInput = null) {
        const plan = resolveExecutionPlan(runInput);
        return plan ? plan.executionOrder : null;
    }

    function getCachedOutputValue(node, portName) {
        if (!node || node.enabled === false) return undefined;
        if (portName === 'params' && node.type === 'CustomParams') {
            return getCustomParamsFromNode(node);
        }
        if (portName === 'image' && node.type === 'ImageImport') {
            return getImageImportOutputValue(node);
        }
        if (portName === 'image') {
            const imageList = normalizeImageList(node?.data?.images || node?.imageDataList || node?.generatedImages);
            if (imageList.length > 1) return imageList;
            if (imageList.length === 1) return imageList[0];

            if (node.type === 'ImageResize') {
                return node.imageData || node.resizePreviewData || undefined;
            }

            if (node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageCompare') {
                return node.imageData || undefined;
            }
        }
        if (portName === 'video') {
            return node.data?.video || undefined;
        }
        if (portName === 'text') {
            if (node.type === 'TextSplit' && node.data?.mergeOutputEnabled === true) {
                const parts = Array.isArray(node.data?.texts) && node.data.texts.length > 0
                    ? node.data.texts
                    : (Array.isArray(node.data?.parts) ? node.data.parts : []);
                return parts.filter((item) => typeof item === 'string');
            }

            if (isFixedTextChatWithCachedResult(node)) {
                return node.data.text;
            }

            if (Array.isArray(node.data?.texts) && node.data.texts.length > 0) {
                return node.data.texts.filter((item) => typeof item === 'string' && item.trim());
            }

            if (node.type === 'Text' || node.type === 'TextInput') {
                return documentRef.getElementById(`${node.id}-text`)?.value;
            }

            if (node.type === 'CameraControl') {
                return node.data?.text || node.data?.cameraPrompt || undefined;
            }

            if (node.type === 'TextChat') {
                const responseArea = documentRef.getElementById(`${node.id}-response`);
                if (!responseArea || responseArea.querySelector('.chat-response-placeholder')) return undefined;
                const responseText = responseArea.innerText.trim();
                return responseText || undefined;
            }

            if (node.type === 'TextDisplay') {
                const display = documentRef.getElementById(`${node.id}-display`);
                const text = display?.textContent?.trim() || '';
                if (!text || text === '等待输入文本...' || text === '当前无输入文本') return undefined;
                return text;
            }
        }

        if (node.data && node.data[portName] !== undefined) {
            return node.data[portName];
        }

        if (/^part_\d+$/.test(portName) && node.type === 'TextSplit') {
            if (node.data && node.data[portName] !== undefined) return node.data[portName];
            const text = node.data?.text || '';
            const delimiter = documentRef.getElementById(`${node.id}-delimiter`)?.value || '';
            const parsedOutputCount = parseInt(documentRef.getElementById(`${node.id}-output-count`)?.value ?? node.data?.outputCount ?? '1', 10);
            const outputCount = Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 1;
            const removeEmptyLines = documentRef.getElementById(`${node.id}-remove-empty-lines`)?.checked === true;
            const rawParts = splitTextForTextSplitNode(text, delimiter, { removeEmptyLines });
            const parts = outputCount === 0 ? rawParts : rawParts.slice(0, outputCount);
            const index = Math.max(0, parseInt(portName.replace('part_', ''), 10) - 1);
            return parts[index];
        }

        return undefined;
    }

    function coerceCustomParamValue(value) {
        const text = String(value ?? '').trim();
        if (!text) return '';
        if (text === 'true') return true;
        if (text === 'false') return false;
        if (text === 'null') return null;
        if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
        try {
            return JSON.parse(text);
        } catch {
            return value;
        }
    }

    function getCustomParamsFromNode(node) {
        const rows = Array.from(documentRef.querySelectorAll(`#${node.id}-params-list [data-param-row]`));
        const params = {};
        rows.forEach((row) => {
            const key = row.querySelector('.custom-param-key')?.value?.trim() || '';
            if (!key) return;
            const value = row.querySelector('.custom-param-value')?.value || '';
            params[key] = coerceCustomParamValue(value);
        });
        node.data = node.data || {};
        node.data.params = Object.entries(params).map(([key, value]) => ({ key, value }));
        return params;
    }

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value);
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function hasRemoteImageValue(value) {
        return normalizeImageList(value).some((image) => isRemoteImageUrl(image));
    }

    function getStoredGeneratedImages(node, completedCount = 0) {
        const images = normalizeImageList(node?.data?.images || node?.generatedImages);
        if (images.length > 0) {
            return completedCount > 0 ? images.slice(0, completedCount) : images;
        }
        return normalizeImageList(node?.data?.image || node?.imageData);
    }

    function getImagePreviewIndex(node, images) {
        if (!images.length) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
    }

    function renderImagePreviewImage(nodeId, images) {
        const previewContainer = documentRef.getElementById(`${nodeId}-preview`);
        if (!previewContainer) return;

        const imageList = normalizeImageList(images);
        if (imageList.length === 0) {
            previewContainer.classList.remove('has-multiple-images');
            previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
            return;
        }

        const node = state.nodes.get(nodeId);
        const index = getImagePreviewIndex(node, imageList);
        if (node) node.imagePreviewIndex = index;
        const image = imageList[index];
        previewContainer.classList.toggle('has-multiple-images', imageList.length > 1);
        previewContainer.innerHTML = `
            <img src="${image}" alt="棰勮 ${index + 1}/${imageList.length}" style="cursor:pointer" draggable="false" />
            ${imageList.length > 1 ? `
                <button type="button" class="image-save-preview-nav image-save-preview-prev" data-direction="-1" title="上一张" aria-label="上一张">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button type="button" class="image-save-preview-nav image-save-preview-next" data-direction="1" title="下一张" aria-label="下一张">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div class="image-save-preview-counter">${index + 1}/${imageList.length}</div>
            ` : ''}
        `;
    }

    function renderImageSavePreview(nodeId, images, emptyMessage = '无输入图片') {
        const previewContainer = documentRef.getElementById(`${nodeId}-save-preview`);
        if (!previewContainer) return;

        const imageList = normalizeImageList(images);
        if (imageList.length === 0) {
            previewContainer.classList.remove('has-multiple-images');
            previewContainer.innerHTML = `<div class="save-preview-placeholder">${emptyMessage}</div>`;
            return;
        }

        const node = state.nodes.get(nodeId);
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        const index = Math.max(0, Math.min(imageList.length - 1, rawIndex));
        if (node) node.imagePreviewIndex = index;
        const image = imageList[index];
        previewContainer.classList.toggle('has-multiple-images', imageList.length > 1);
        previewContainer.innerHTML = `
            <img src="${image}" alt="待保存 ${index + 1}/${imageList.length}" draggable="false" />
            ${imageList.length > 1 ? `
                <button type="button" class="image-save-preview-nav image-save-preview-prev" data-direction="-1" title="上一张" aria-label="上一张">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button type="button" class="image-save-preview-nav image-save-preview-next" data-direction="1" title="下一张" aria-label="下一张">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div class="image-save-preview-counter">${index + 1}/${imageList.length}</div>
            ` : ''}
        `;
    }

    function hasRemoteImageInput(inputs = {}) {
        return Object.values(inputs).some((value) => hasRemoteImageValue(value));
    }

    function getReferenceImageInputs(inputs = {}) {
        return Object.keys(inputs)
            .filter((key) => /^image_\d+$/.test(key))
            .sort((a, b) => {
                const numA = parseInt(a.slice('image_'.length), 10) || 0;
                const numB = parseInt(b.slice('image_'.length), 10) || 0;
                return numA - numB;
            })
            .map((key) => ({ key, value: getPrimaryImageInput(inputs[key]) }))
            .filter((entry) => entry.value);
    }

    function getImageFileExtension(mimeType = '') {
        const mime = String(mimeType || '').toLowerCase();
        if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
        if (mime.includes('webp')) return 'webp';
        if (mime.includes('gif')) return 'gif';
        return 'png';
    }

    async function getReferenceImageBlob(value, signal) {
        if (isInlineImageData(value)) return dataURLtoBlob(value);
        if (isRemoteImageUrl(value)) return downloadGeneratedImage(value, signal);
        throw new Error('OpenAI 兼容图片编辑只支持 data URL 或 HTTP(S) 参考图');
    }

    async function buildOpenAiImageEditFormData(requestBody, inputs, signal) {
        const formData = new FormData();
        const referenceImages = getReferenceImageInputs(inputs);

        formData.append('model', requestBody.model);
        formData.append('prompt', requestBody.prompt);
        if (requestBody.n !== undefined) formData.append('n', String(requestBody.n));
        if (requestBody.size) formData.append('size', requestBody.size);
        if (requestBody.quality) formData.append('quality', requestBody.quality);

        for (let index = 0; index < referenceImages.length; index += 1) {
            const blob = await getReferenceImageBlob(referenceImages[index].value, signal);
            const extension = getImageFileExtension(blob?.type);
            formData.append('image', blob, `reference_${index + 1}.${extension}`);
        }

        return formData;
    }

    function getOpenAiImageRequestLogBody(requestBody, inputs) {
        const referenceImages = getReferenceImageInputs(inputs);
        if (referenceImages.length === 0) return requestBody;
        return {
            model: requestBody.model,
            prompt: requestBody.prompt,
            n: requestBody.n,
            ...(requestBody.size ? { size: requestBody.size } : {}),
            ...(requestBody.quality ? { quality: requestBody.quality } : {}),
            image: `[${referenceImages.length} reference image file(s)]`
        };
    }

    const nodeHandlers = {
        ImageImport: async (node) => {
            if (!node.imageData) throw new Error('未导入图片');
            node.data.image = node.imageData;
            await refreshDependentImageResizePreviews(node.id);
        },
        ImageResize: async (node, inputs) => {
            const { id } = node;
            const sourceImage = getPrimaryImageInput(inputs.image);
            if (!sourceImage) throw new Error('无输入图片');

            const mode = documentRef.getElementById(`${id}-resize-mode`)?.value || 'scale';
            const scalePercent = Math.max(1, Math.min(100, parseInt(documentRef.getElementById(`${id}-scale-percent`)?.value || '100', 10) || 100));
            const targetWidth = documentRef.getElementById(`${id}-target-width`)?.value || '';
            const targetHeight = documentRef.getElementById(`${id}-target-height`)?.value || '';
            const keepAspect = documentRef.getElementById(`${id}-keep-aspect`)?.checked !== false;
            const quality = parseInt(documentRef.getElementById(`${id}-quality`)?.value || '92', 10);

            const result = await resizeImageData(sourceImage, {
                mode,
                scalePercent,
                targetWidth,
                targetHeight,
                keepAspect,
                quality
            });

            node.data.image = result.dataUrl;
            node.imageData = result.dataUrl;
            node.resizePreviewData = result.dataUrl;
            node.resizePreviewMeta = result;
            node.originalWidth = result.originalWidth;
            node.originalHeight = result.originalHeight;
            node.outputWidth = result.outputWidth;
            node.outputHeight = result.outputHeight;
            node.outputFormat = result.outputFormat;
            node.outputQuality = result.outputQuality;
            node.estimatedBytes = result.estimatedBytes;

            restoreImageResizePreview(id, result.dataUrl, result);
            showResolutionBadge(id, result.dataUrl);
            await saveImageAsset(id, result.dataUrl);
            await refreshDependentImageResizePreviews(id);
        },
        ImageGenerate: async (node, inputs, signal, executionContext = {}) => {
            const { id } = node;
            const errorEl = documentRef.getElementById(`${id}-error`);
            if (errorEl) {
                errorEl.style.display = 'none';
                requestNodeFit(id);
            }
            let targetGenerationCount = 1;

            try {
                const configId = documentRef.getElementById(`${id}-apiconfig`).value;
                const modelCfg = state.models.find((model) => model.id === configId);
                if (!modelCfg) throw new Error('未找到选定的模型配置');
                const selectedProviderId = documentRef.getElementById(`${id}-provider`)?.value || node.providerId || '';
                const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
                const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
                if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
                node.providerId = resolvedProviderId;

                const aspect = documentRef.getElementById(`${id}-aspect`).value;
                const selectedResolution = documentRef.getElementById(`${id}-resolution`).value;
                const customWidth = documentRef.getElementById(`${id}-custom-resolution-width`)?.value || '';
                const customHeight = documentRef.getElementById(`${id}-custom-resolution-height`)?.value || '';
                const customResolution = customWidth && customHeight ? `${customWidth}x${customHeight}` : '';
                const resolution = selectedResolution === 'custom' ? customResolution : selectedResolution;
                const quality = documentRef.getElementById(`${id}-quality`)?.value || 'auto';
                const searchEnabled = documentRef.getElementById(`${id}-search`).checked;
                const userPrompt = getPrimaryTextInput(inputs.prompt) || documentRef.getElementById(`${id}-prompt`).value;
                const cameraPrompt = getPrimaryTextInput(inputs.camera_prompt).trim();
                const prompt = [cameraPrompt, userPrompt].filter((part) => typeof part === 'string' && part.trim()).join(', ');

                if (!apiCfg.apikey) throw new Error('API 提供商密钥未配置');
                if (!prompt) throw new Error('请输入提示词');

                const protocol = getEffectiveProtocol(modelCfg, apiCfg);
                const isGoogle = protocol === 'google';
                if (!isGoogle && selectedResolution === 'custom') {
                    const validation = validateOpenAiImageSize(customWidth, customHeight);
                    if (!validation.valid) throw new Error(`自定义分辨率不符合 OpenAI 规范：${validation.errors.join(' ')}`);
                }
                const url = resolveProviderUrl(apiCfg, modelCfg, 'image', { inputs });
                const isOpenAiImageEdit = !isGoogle && /\/images\/edits(?:$|[?#])/i.test(url);
                const headers = isGoogle
                    ? getProxyHeaders(url, 'POST')
                    : getProxyHeaders(url, 'POST', {
                        Authorization: `Bearer ${apiCfg.apikey}`,
                        'Content-Type': isOpenAiImageEdit ? null : 'application/json'
                    });
                const generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
                targetGenerationCount = generationCount;
                const storedCompletedCount = Math.min(
                    generationCount,
                    Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0)
                );
                const storedGeneratedImages = getStoredGeneratedImages(node, storedCompletedCount).slice(0, generationCount);
                if (!executionContext.concurrentExecution) {
                    commitImageGenerateOutputs(node, storedGeneratedImages, prompt);
                }
                renderNodeApiGenerationProgress(node, {
                    current: executionContext.concurrentExecution ? 0 : node.generationCompletedCount,
                    total: generationCount
                });

                const shouldRunConcurrentRequests = isConcurrentRequestModeEnabled() &&
                    (generationCount > 1 || executionContext.concurrentExecution);
                if (shouldRunConcurrentRequests) {
                    const progressTotal = Math.max(1, parseInt(node.apiGenerationProgress?.total ?? generationCount, 10) || generationCount);
                    const generatedImages = executionContext.concurrentExecution
                        ? new Array(generationCount)
                        : getStoredGeneratedImages(node, node.generationCompletedCount).slice(0, generationCount);
                    const completedBefore = executionContext.concurrentExecution
                        ? 0
                        : Math.min(generationCount, normalizeImageList(generatedImages).length);

                    if (completedBefore >= generationCount) {
                        const completedImages = normalizeImageList(generatedImages);
                        if (!executionContext.concurrentExecution) {
                            commitImageGenerateOutputs(node, completedImages, prompt);
                            node.isSucceeded = true;
                            await refreshDependentImageResizePreviews(id);
                            updateAllConnections();
                        }
                        return {
                            image: completedImages[completedImages.length - 1] || '',
                            images: completedImages.slice()
                        };
                    }

                    const runSingleGeneration = async (nextGenerationIndex) => {
                        const requestBody = isGoogle
                            ? buildGoogleImageRequest({ prompt, inputs, aspect, resolution, searchEnabled })
                            : buildOpenAiImageRequest({ modelCfg, prompt, resolution, quality, inputs });
                        showToast(
                            generationCount > 1
                                ? `正在调用 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})...`
                                : `正在调用 ${modelCfg.name}...`,
                            'info',
                            5000
                        );

                        const requestPayload = isOpenAiImageEdit
                            ? await buildOpenAiImageEditFormData(requestBody, inputs, signal)
                            : JSON.stringify(requestBody);
                        const loggedRequestBody = isOpenAiImageEdit
                            ? getOpenAiImageRequestLogBody(requestBody, inputs)
                            : requestBody;
                        logRequestToPanel(
                            generationCount > 1
                                ? `请求发送: ${modelCfg.name} (${nextGenerationIndex}/${generationCount})`
                                : `请求发送: ${modelCfg.name}`,
                            url,
                            loggedRequestBody,
                            {
                                nodeId: id,
                                nodeType: 'TextToImage',
                                providerType: protocol
                            }
                        );

                        const response = await fetchRef('/proxy', {
                            method: 'POST',
                            headers,
                            body: requestPayload,
                            signal
                        });

                        if (!response.ok) {
                            const t = await response.text();
                            const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                            const err = new Error(formatProxyErrorMessage(response.status, t, 'API 错误', errorContext));
                            err.serverResponse = {
                                url,
                                requestBody,
                                status: response.status,
                                body: t
                            };
                            applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                            throw err;
                        }

                        const result = await parseJsonResponseOrThrow(response, {
                            apiCfg,
                            modelCfg,
                            url,
                            requestBody
                        });
                        if (!result) throw new Error('API 返回了空的 JSON 响应');

                        let imageData = '';
                        const imageResult = extractImageResult(apiCfg, result, modelCfg);
                        if (imageResult?.dataUrl) {
                            imageData = imageResult.dataUrl;
                        } else if (imageResult?.url) {
                            const imgBlob = await downloadGeneratedImage(imageResult.url, signal);
                            imageData = await blobToDataUrl(imgBlob);
                        }

                        if (!imageData) {
                            const err = new Error(getImageGenerationError(apiCfg, result, modelCfg));
                            err.serverResponse = JSON.stringify(result, null, 2);
                            throw err;
                        }

                        return imageData;
                    };

                    const requestIndexes = Array.from(
                        { length: generationCount - completedBefore },
                        (_, offset) => completedBefore + offset
                    );
                    const markConcurrentRequestStatus = (relativeIndex, status, error = null) => {
                        executionContext.concurrentRequestStatus?.markRequestStatus?.(relativeIndex, status, error);
                    };
                    const requestResults = await Promise.allSettled(requestIndexes.map((index) => {
                        const nextGenerationIndex = index + 1;
                        return runRequestWithRetries(() => runSingleGeneration(nextGenerationIndex), {
                            label: generationCount > 1
                                ? `图片生成 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})`
                                : `图片生成 ${modelCfg.name}`,
                            signal
                        }).then(async (imageData) => {
                            generatedImages[index] = imageData;
                            incrementNodeApiGenerationProgress(node, 1, {
                                current: nextGenerationIndex,
                                total: progressTotal
                            });
                            await saveImageGenerationHistoryEntry({
                                nodeId: id,
                                image: imageData,
                                prompt,
                                model: modelCfg.name,
                                generationDurationSeconds: getNodeGenerationDurationSeconds(node)
                            });
                            if (getImageHistorySidebarActive()) renderHistoryList();
                            markConcurrentRequestStatus(index, 'success');
                        }).catch((error) => {
                            markConcurrentRequestStatus(index, 'failed', error);
                            throw error;
                        });
                    }));
                    const rejectedRequests = requestResults.filter((result) => result.status === 'rejected');
                    const abortRejection = rejectedRequests.find((result) => isAbortLikeError(result.reason, signal));
                    if (abortRejection) {
                        throw abortRejection.reason;
                    }
                    const completedImages = normalizeImageList(generatedImages);
                    if (rejectedRequests.length > 0) {
                        if (!executionContext.concurrentExecution) {
                            commitImageGenerateOutputs(node, completedImages, prompt);
                            await refreshDependentImageResizePreviews(id);
                            updateAllConnections();
                        }
                        addLog(completedImages.length > 0 ? 'warning' : 'error', `图片生成部分失败: ${modelCfg.name}`, `${requestResults.length} 个请求中 ${rejectedRequests.length} 个失败，${completedImages.length} 个成功。${completedImages.length > 0 ? '将仅把成功图片传递到下游。' : '没有可传递的成功图片。'}`, {
                            nodeId: id,
                            successCount: completedImages.length,
                            failedCount: rejectedRequests.length,
                            errors: rejectedRequests.map((result) => result.reason?.message || String(result.reason))
                        });
                    }
                    if (completedImages.length === 0 && rejectedRequests.length > 0) {
                        throw rejectedRequests[0].reason;
                    }

                    if (!executionContext.concurrentExecution) {
                        commitImageGenerateOutputs(node, completedImages, prompt);
                        node.isSucceeded = true;
                        await refreshDependentImageResizePreviews(id);
                        updateAllConnections();
                    }

                    return {
                        image: completedImages[completedImages.length - 1] || '',
                        images: completedImages.slice()
                    };
                }

                while (node.generationCompletedCount < generationCount) {
                    const nextGenerationIndex = node.generationCompletedCount + 1;
                    renderNodeApiGenerationProgress(node, {
                        current: node.generationCompletedCount,
                        total: generationCount
                    });
                    const requestBody = isGoogle
                        ? buildGoogleImageRequest({ prompt, inputs, aspect, resolution, searchEnabled })
                        : buildOpenAiImageRequest({ modelCfg, prompt, resolution, quality, inputs });
                    showToast(
                        generationCount > 1
                            ? `正在调用 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})...`
                            : `正在调用 ${modelCfg.name}...`,
                        'info',
                        5000
                    );

                    const requestPayload = isOpenAiImageEdit
                        ? await buildOpenAiImageEditFormData(requestBody, inputs, signal)
                        : JSON.stringify(requestBody);
                    const loggedRequestBody = isOpenAiImageEdit
                        ? getOpenAiImageRequestLogBody(requestBody, inputs)
                        : requestBody;
                    logRequestToPanel(
                        generationCount > 1
                            ? `请求发送: ${modelCfg.name} (${nextGenerationIndex}/${generationCount})`
                            : `请求发送: ${modelCfg.name}`,
                        url,
                        loggedRequestBody,
                        {
                            nodeId: id,
                            nodeType: 'TextToImage',
                            providerType: protocol
                        }
                    );

                    const response = await fetchRef('/proxy', {
                        method: 'POST',
                        headers,
                        body: requestPayload,
                        signal
                    });

                    if (!response.ok) {
                        const t = await response.text();
                        const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                        const err = new Error(formatProxyErrorMessage(response.status, t, 'API 错误', errorContext));
                        err.serverResponse = {
                            url,
                            requestBody,
                            status: response.status,
                            body: t
                        };
                        applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                        throw err;
                    }

                    const result = await parseJsonResponseOrThrow(response, {
                        apiCfg,
                        modelCfg,
                        url,
                        requestBody
                    });
                        if (!result) throw new Error('API 返回了空的 JSON 响应');

                    let imageData = '';
                    const imageResult = extractImageResult(apiCfg, result, modelCfg);
                    if (imageResult?.dataUrl) {
                        imageData = imageResult.dataUrl;
                    } else if (imageResult?.url) {
                        const imgBlob = await downloadGeneratedImage(imageResult.url, signal);
                        imageData = await blobToDataUrl(imgBlob);
                    }

                    if (!imageData) {
                        const err = new Error(getImageGenerationError(apiCfg, result, modelCfg));
                        err.serverResponse = JSON.stringify(result, null, 2);
                        throw err;
                    }

                    node.generatedImages = normalizeImageList(node.generatedImages);
                    node.generatedImages[nextGenerationIndex - 1] = imageData;
                    commitImageGenerateOutputs(node, node.generatedImages.slice(0, nextGenerationIndex), prompt);
                    incrementNodeApiGenerationProgress(node, 1, {
                        current: nextGenerationIndex,
                        total: generationCount
                    });
                    await refreshDependentImageResizePreviews(id);

                    await saveImageGenerationHistoryEntry({
                        nodeId: id,
                        image: imageData,
                        prompt,
                        model: modelCfg.name,
                        generationDurationSeconds: getNodeGenerationDurationSeconds(node)
                    });
                    if (getImageHistorySidebarActive()) renderHistoryList();
                }
            } catch (err) {
                if (isAbortLikeError(err, signal)) {
                    renderNodeApiGenerationProgress(node, {
                        current: Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0),
                        total: targetGenerationCount
                    });
                    if (errorEl) {
                        errorEl.innerHTML = '';
                        errorEl.style.display = 'none';
                    }
                    throw err;
                }
                renderNodeApiGenerationProgress(node, {
                    current: Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0),
                    total: targetGenerationCount
                });
                if (errorEl) {
                    const completedCount = Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0);
                    const progressText = targetGenerationCount > 1
                        ? `<div>已成功 ${completedCount}/${targetGenerationCount} 次，本次失败不计入次数。</div>`
                        : '';
                    const runtimeFailedProgress = node.apiGenerationProgress || {};
                    const runtimeFailedTotal = Math.max(1, parseInt(runtimeFailedProgress.total ?? targetGenerationCount, 10) || 1);
                    const runtimeCompletedCount = Math.max(0, Math.min(runtimeFailedTotal, parseInt(runtimeFailedProgress.completed ?? completedCount, 10) || 0));
                    const runtimeProgressText = runtimeFailedTotal > 1
                        ? progressText.replace(`${completedCount}/${targetGenerationCount}`, `${runtimeCompletedCount}/${runtimeFailedTotal}`)
                        : '';
                    errorEl.innerHTML = `<strong>生成失败</strong>${runtimeProgressText}${escapeHtml(err.message || '未知错误')}`;
                    errorEl.style.display = 'block';
                    requestNodeFit(id);
                }
                throw err;
            }
        },
        VideoGenerate: async (node, inputs, signal) => {
            const { id } = node;
            const errorEl = documentRef.getElementById(`${id}-error`);
            const responseArea = documentRef.getElementById(`${id}-response`);
            const downloadBtn = documentRef.getElementById(`${id}-download-video`);
            if (errorEl) {
                errorEl.style.display = 'none';
                errorEl.innerHTML = '';
                requestNodeFit(id);
            }

            const configId = documentRef.getElementById(`${id}-apiconfig`)?.value || '';
            const modelCfg = state.models.find((model) => model.id === configId);
            if (!modelCfg) throw new Error('未找到选定的视频模型配置');
            const selectedProviderId = documentRef.getElementById(`${id}-provider`)?.value || node.providerId || '';
            const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
            const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
            if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
            node.providerId = resolvedProviderId;

            const prompt = getPrimaryTextInput(inputs.prompt) || documentRef.getElementById(`${id}-prompt`)?.value || '';
            const aspect = documentRef.getElementById(`${id}-aspect`)?.value || '16:9';
            const enhancePrompt = documentRef.getElementById(`${id}-enhance-prompt`)?.checked === true;
            const enableUpsample = documentRef.getElementById(`${id}-enable-upsample`)?.checked === true;
            const doubaoResolution = documentRef.getElementById(`${id}-doubao-resolution`)?.value || '';
            const doubaoDuration = documentRef.getElementById(`${id}-doubao-duration`)?.value || '';
            const doubaoCameraFixed = documentRef.getElementById(`${id}-doubao-camera-fixed`)?.checked === true;
            const doubaoGenerateAudio = documentRef.getElementById(`${id}-doubao-generate-audio`)?.checked === true;
            const doubaoWatermark = documentRef.getElementById(`${id}-doubao-watermark`)?.checked === true;
            const doubaoSeed = documentRef.getElementById(`${id}-doubao-seed`)?.value || '';
            const generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
            const protocol = getEffectiveProtocol(modelCfg, apiCfg);
            const normalizedModelId = String(modelCfg.modelId || '').toLowerCase();

            if (!apiCfg.apikey) throw new Error('API 提供商密钥未配置');
            if (!prompt.trim()) throw new Error('请输入提示词');
            if (protocol === 'doubao-video') {
                const durationValue = parseInt(doubaoDuration, 10);
                const minDuration = normalizedModelId.includes('seedance-1-5-pro') ? 4 : 2;
                if (!Number.isFinite(durationValue) || durationValue < minDuration || durationValue > 12) {
                    throw new Error(`豆包视频时长不符合要求：当前模型只支持 ${minDuration}-12 秒`);
                }
                if (doubaoSeed !== '') {
                    const seedValue = parseInt(doubaoSeed, 10);
                    if (!Number.isFinite(seedValue) || seedValue < 0) {
                        throw new Error('豆包视频种子必须为空或大于等于 0，不能传 -1');
                    }
                }
            }

            const results = [];
            renderNodeApiGenerationProgress(node, { current: 0, total: generationCount });
            if (responseArea) {
                responseArea.innerHTML = '<div class="chat-response-placeholder">正在提交视频任务...</div>';
            }
            updateVideoGenerationStatus(id, '创建中：正在提交视频任务...', 'progress');
            if (downloadBtn) downloadBtn.disabled = true;

            for (let index = 0; index < generationCount; index += 1) {
                const url = resolveProviderUrl(apiCfg, modelCfg, 'video', { action: 'create' });
                const requestBody = protocol === 'veo-openai'
                    ? buildOpenAiVideoRequest({ modelCfg, prompt, aspectRatio: aspect, inputs })
                    : (protocol === 'doubao-video'
                        ? buildDoubaoVideoRequest({
                            modelCfg,
                            prompt,
                            aspectRatio: aspect,
                            resolution: doubaoResolution,
                            duration: doubaoDuration,
                            cameraFixed: doubaoCameraFixed,
                            generateAudio: doubaoGenerateAudio,
                            watermark: doubaoWatermark,
                            seed: doubaoSeed,
                            inputs
                        })
                        : buildUnifiedVideoRequest({ modelCfg, prompt, aspectRatio: aspect, enhancePrompt, enableUpsample, inputs }));
                const headers = getProxyHeaders(url, 'POST', {
                    Authorization: `Bearer ${apiCfg.apikey}`
                });

                logRequestToPanel(
                    generationCount > 1 ? `视频请求发送: ${modelCfg.name} (${index + 1}/${generationCount})` : `视频请求发送: ${modelCfg.name}`,
                    url,
                    requestBody,
                    {
                        nodeId: id,
                        nodeType: 'VideoGenerate',
                        providerType: protocol
                    }
                );

                const response = await fetchRef('/proxy', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                    signal
                });

                if (!response.ok) {
                    const t = await response.text();
                    const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                    const err = new Error(formatProxyErrorMessage(response.status, t, '视频创建失败', errorContext));
                    err.serverResponse = {
                        url,
                        requestBody,
                        status: response.status,
                        body: t
                    };
                    throw err;
                }

                const createResponseContext = {
                    apiCfg,
                    modelCfg,
                    url,
                    requestBody
                };
                const createResult = await parseJsonResponseOrThrow(response, createResponseContext);
                addLog('info', generationCount > 1 ? `视频创建响应: ${modelCfg.name} (${index + 1}/${generationCount})` : `视频创建响应: ${modelCfg.name}`, '已收到创建任务返回', {
                    url,
                    method: 'POST',
                    status: response.status,
                    providerType: protocol,
                    contentType: createResponseContext.__responseContentType || '',
                    rawResponseBody: createResponseContext.__rawResponseText || '',
                    responseBody: createResult
                });
                const videoId = extractVideoTaskId(createResult, protocol);
                if (!videoId) throw new Error('视频创建成功，但接口没有返回任务 ID');
                const createSummary = getVideoCreateResponseSummary(createResult, videoId);
                commitVideoGenerateOutputs(node, {
                    videoId: createSummary.videoId || videoId,
                    videoUrl: '',
                    status: createSummary.status || 'submitted',
                    statusText: `创建中：任务 ${createSummary.videoId || videoId} 已创建，等待轮询`,
                    prompt,
                    createHttpStatus: response.status,
                    createStatus: createSummary.status,
                    statusUpdateTime: createSummary.statusUpdateTime,
                    enhancedPrompt: createSummary.enhancedPrompt
                });

                if (responseArea) {
                    responseArea.innerHTML = buildVideoCreateResponseHtml({
                        httpStatus: response.status,
                        videoId: createSummary.videoId || videoId,
                        status: createSummary.status,
                        statusUpdateTime: createSummary.statusUpdateTime,
                        enhancedPrompt: createSummary.enhancedPrompt
                    });
                }
                scheduleSave();
                updateVideoGenerationStatus(
                    id,
                    generationCount > 1
                        ? `轮询中：第 ${index + 1}/${generationCount} 个任务已创建，正在检查状态`
                        : `轮询中：任务 ${createSummary.videoId || videoId} 已创建，正在检查状态`,
                    'progress'
                );

                const finalResult = await pollVideoGeneration({
                    apiCfg,
                    modelCfg,
                    protocol,
                    videoId: createSummary.videoId || videoId,
                    signal,
                    prompt
                });
                results.push(finalResult);
                incrementNodeApiGenerationProgress(node, 1, { current: index + 1, total: generationCount });
            }

            const lastResult = results[results.length - 1] || {};
            commitVideoGenerateOutputs(node, lastResult);
            node.data.videos = results.slice();
            node.isSucceeded = true;

            if (responseArea) {
                responseArea.innerHTML = results.map((result, index) => {
                    const linkHtml = result.videoUrl
                        ? `<a href="${escapeHtml(result.videoUrl)}" target="_blank" rel="noreferrer">打开视频 ${index + 1}</a>`
                        : '视频地址待供应商提供';
                    return `<div><strong>第 ${index + 1} 个结果</strong></div><div>${linkHtml}</div><div style="margin-top:4px;color:var(--text-dim);">${escapeHtml(result.statusText || result.status || '')}</div>`;
                }).join('<hr />');
            }
            updateVideoGenerationStatus(id, generationCount > 1 ? `已完成：${generationCount} 个视频都已生成完成` : '已完成：视频生成成功', 'success');
            if (downloadBtn) downloadBtn.disabled = !lastResult.videoUrl;
            completeNodeApiGenerationProgress(node, { current: generationCount, total: generationCount });
            return {
                video: lastResult.videoUrl
                    ? {
                        id: lastResult.videoId,
                        url: lastResult.videoUrl,
                        status: lastResult.status,
                        prompt
                    }
                    : undefined
            };
        },
        TextChat: async (node, inputs, signal, executionContext = {}) => {
            const { id } = node;
            const fixedToggle = documentRef.getElementById(`${id}-fixed`);
            const isFixed = fixedToggle ? fixedToggle.checked : false;

            if (isFixed && node.isSucceeded && node.data && node.data.text) {
                completeNodeApiGenerationProgress(node);
                const cachedHtml = node.lastResponse || escapeHtml(node.data.text).replace(/\n/g, '<br>');
                const responseArea = documentRef.getElementById(`${id}-response`);
                if (responseArea) responseArea.innerHTML = cachedHtml;
                return {
                    text: node.data.text,
                    lastResponse: cachedHtml
                };
            }

            const configId = documentRef.getElementById(`${id}-apiconfig`).value;
            const modelCfg = state.models.find((model) => model.id === configId);
            if (!modelCfg) throw new Error('未找到选定的模型配置');
            const selectedProviderId = documentRef.getElementById(`${id}-provider`)?.value || node.providerId || '';
            const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
            const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
            if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
            node.providerId = resolvedProviderId;

            const sysprompt = documentRef.getElementById(`${id}-sysprompt`).value;
            const prompt = inputs.prompt || documentRef.getElementById(`${id}-prompt`).value;
            const responseArea = documentRef.getElementById(`${id}-response`);

            if (!apiCfg.apikey) throw new Error('API 提供商密钥未配置');
            if (!prompt) throw new Error('请输入提问内容');

            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
            responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';
            renderNodeApiGenerationProgress(node, { current: 0, total: 1 });

            try {
                let jsonResponse = null;
                let responseText = '';
                const protocol = getEffectiveProtocol(modelCfg, apiCfg);

                if (protocol === 'google') {
                    const searchEnabled = documentRef.getElementById(`${id}-search`)?.checked || false;
                    const body = buildGoogleChatRequest({ prompt, inputs, sysprompt, searchEnabled });
                    const url = resolveProviderUrl(apiCfg, modelCfg, 'chat');

                    const headers = getProxyHeaders(url, 'POST');
                    logRequestToPanel(`请求发送: ${modelCfg.name}`, url, body, {
                        nodeId: id,
                        nodeType: 'TextChat',
                        providerType: protocol
                    });

                    const res = await fetchRef('/proxy', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        signal
                    });
                    if (!res.ok) {
                        const t = await res.text();
                        const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                        const err = new Error(formatProxyErrorMessage(res.status, t, '请求失败', errorContext));
                        err.serverResponse = {
                            url,
                            requestBody: body,
                            status: res.status,
                            body: t
                        };
                        applyUserFacingError(err, classifyProviderError(res.status, t, errorContext));
                        throw err;
                    }
                    jsonResponse = await parseJsonResponseOrThrow(res, {
                        apiCfg,
                        modelCfg,
                        url,
                        requestBody: body
                    });

                    let resultText = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (jsonResponse.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.html) {
                        resultText += `\n\n<div class="search-chips">${jsonResponse.candidates[0].groundingMetadata.searchEntryPoint.html}</div>`;
                    }
                    responseText = resultText;
                } else {
                    const url = resolveProviderUrl(apiCfg, modelCfg, 'chat');
                    const requestBody = buildOpenAiChatRequest({ modelCfg, prompt, inputs, sysprompt });
                    const headers = getProxyHeaders(url, 'POST', {
                        Authorization: `Bearer ${apiCfg.apikey}`
                    });
                    logRequestToPanel(`请求发送: ${modelCfg.name}`, url, requestBody, {
                        nodeId: id,
                        nodeType: 'TextChat',
                        providerType: protocol
                    });

                    const res = await fetchRef('/proxy', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(requestBody),
                        signal
                    });
                    if (!res.ok) {
                        const t = await res.text();
                        const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                        const err = new Error(formatProxyErrorMessage(res.status, t, '请求失败', errorContext));
                        err.serverResponse = {
                            url,
                            requestBody,
                            status: res.status,
                            body: t
                        };
                        applyUserFacingError(err, classifyProviderError(res.status, t, errorContext));
                        throw err;
                    }
                    jsonResponse = await parseJsonResponseOrThrow(res, {
                        apiCfg,
                        modelCfg,
                        url,
                        requestBody
                    });
                    responseText = jsonResponse.choices?.[0]?.message?.content || '';
                }

                if (!responseText) {
                    const err = new Error('API 未返回文本内容');
                    if (jsonResponse) err.serverResponse = JSON.stringify(jsonResponse, null, 2);
                    throw err;
                }
                const responseHtml = windowRef.marked && windowRef.marked.parse
                    ? windowRef.marked.parse(responseText)
                    : escapeHtml(responseText).replace(/\n/g, '<br>');

                incrementNodeApiGenerationProgress(node);

                if (!executionContext.concurrentExecution) {
                    if (windowRef.marked && windowRef.marked.parse) {
                        responseArea.innerHTML = responseHtml;
                    } else {
                        responseArea.innerText = responseText;
                    }
                    node.data.text = responseText;
                    node.lastResponse = responseHtml;
                    node.isSucceeded = true;
                    updateAllConnections();
                }

                return {
                    text: responseText,
                    lastResponse: responseHtml
                };
            } catch (err) {
                renderNodeApiGenerationProgress(node, { current: 0, total: 1 });
                responseArea.innerHTML = `<div class="chat-response-placeholder" style="color:var(--accent-red)">失败: ${err.message}</div>`;
                throw err;
            }
        },
        CustomParams: async (node) => {
            const params = getCustomParamsFromNode(node);
            node.data = node.data || {};
            node.data.params = Object.entries(params).map(([key, value]) => ({ key, value }));
            return { params };
        },
        ImagePreview: async (node, inputs) => {
            const { id } = node;
            const imageList = normalizeImageList(inputs.image);
            const imgData = imageList[0] || null;
            if (imgData) {
                await syncImagePreviewNode(id, imageList);
                await refreshDependentImageResizePreviews(id);
            } else {
                await syncImagePreviewNode(id, []);
                await refreshDependentImageResizePreviews(id);
            }
            requestNodeFit(id);
        },
        ImageCompare: async (node, inputs) => {
            const { id } = node;
            const imageA = getPrimaryImageInput(inputs.imageA);
            const imageB = getPrimaryImageInput(inputs.imageB);
            if (!imageB) throw new Error('B 输入未连接图片');
            await syncImageCompareNode(id, imageA || null, imageB);
            await refreshDependentImageResizePreviews(id);
        },
        ImageMerge: async (node, inputs = {}) => {
            const images = Object.entries(inputs)
                .filter(([key]) => /^image_\d+$/.test(key))
                .sort(([a], [b]) => parseInt(a.replace('image_', ''), 10) - parseInt(b.replace('image_', ''), 10))
                .flatMap(([, value]) => normalizeImageList(value));
            if (images.length === 0) throw new Error('请至少连接一张图片');
            node.data.images = images.slice();
            node.data.image = images[images.length - 1];
            node.imageDataList = images.slice();
            node.imageData = node.data.image;
            await saveImageAssetList(node.id, images);
            const summary = documentRef.getElementById(`${node.id}-merge-summary`);
            if (summary) summary.textContent = `已合并 ${images.length} 张图片`;
            await refreshDependentImageResizePreviews(node.id);
            updateAllConnections();
        },
        TextMerge: async (node, inputs = {}) => {
            const texts = Object.entries(inputs)
                .filter(([key]) => /^text_\d+$/.test(key))
                .sort(([a], [b]) => parseInt(a.replace('text_', ''), 10) - parseInt(b.replace('text_', ''), 10))
                .flatMap(([, value]) => getTextInputList(value))
                .filter((value) => typeof value === 'string');
            if (texts.length === 0) throw new Error('请至少连接一段文本');
            node.data.texts = texts.slice();
            node.data.text = texts[texts.length - 1];
            const summary = documentRef.getElementById(`${node.id}-merge-summary`);
            if (summary) summary.textContent = `已合并 ${texts.length} 段文本`;
            updateAllConnections();
        },
        ImageSave: async (node, inputs) => {
            const { id } = node;
            const imageList = normalizeImageList(inputs.image);
            const videoData = inputs.video && typeof inputs.video === 'object' ? inputs.video : null;
            const imgData = imageList.length > 0 ? imageList[imageList.length - 1] : null;
            if (imgData) {
                await syncImageSaveNode(id, { images: imageList, video: null });
                await autoSaveToDir(id, { images: imageList, video: null });
                await refreshDependentImageResizePreviews(id);
            } else if (videoData?.url) {
                await syncImageSaveNode(id, { images: [], video: videoData });
                await autoSaveToDir(id, { images: [], video: videoData });
            } else {
                await syncImageSaveNode(id, { images: [], video: null });
                await refreshDependentImageResizePreviews(id);
            }
        },
        TextInput: async (node) => {
            node.data.text = documentRef.getElementById(`${node.id}-text`).value;
        },
        Text: async (node, inputs = {}) => {
            const textarea = documentRef.getElementById(`${node.id}-text`);
            const hasIncomingText = Object.prototype.hasOwnProperty.call(inputs, 'text');
            const texts = getTextInputList(inputs.text);
            const text = texts.length > 0
                ? texts[0]
                : (hasIncomingText ? getPrimaryTextInput(inputs.text) : (textarea?.value || node.data.text || ''));
            if (texts.length > 0) {
                node.data.texts = texts.slice();
                node.textPreviewIndex = 0;
            } else {
                delete node.data.texts;
                node.textPreviewIndex = 0;
            }
            if (textarea && textarea.value !== text) textarea.value = text;
            node.data.text = text;
            const nav = documentRef.getElementById(`${node.id}-text-nav`);
            const counter = documentRef.getElementById(`${node.id}-text-counter`);
            if (nav) nav.classList.toggle('hidden', texts.length <= 1);
            if (counter) counter.textContent = texts.length > 1 ? `1/${texts.length}` : '';
            updateAllConnections();
        },
        CameraControl: async (node, inputs = {}) => {
            if (Object.prototype.hasOwnProperty.call(inputs, 'image')) {
                node.data.image = getPrimaryImageInput(inputs.image);
            }
            const cameraData = {
                pitch: Number(node.data?.pitch ?? 12),
                yaw: Number(node.data?.yaw ?? 28),
                distance: Number(node.data?.distance ?? 6.5),
                fov: Number(node.data?.fov ?? 50),
                roll: Number(node.data?.roll ?? 0)
            };
            const promptText = generateCameraPrompt(cameraData);
            node.data.text = promptText;
            node.data.cameraPrompt = promptText;
            syncCameraControlNode(node.id, getPrimaryImageInput(inputs.image) || node.data.image || '');
            updateAllConnections();
        },
        TextSplit: async (node, inputs = {}) => {
            const delimiterInput = documentRef.getElementById(`${node.id}-delimiter`);
            const outputCountInput = documentRef.getElementById(`${node.id}-output-count`);
            const removeEmptyLinesInput = documentRef.getElementById(`${node.id}-remove-empty-lines`);
            const mergeOutputEnabledInput = documentRef.getElementById(`${node.id}-merge-output-enabled`);
            const hasIncomingText = Object.prototype.hasOwnProperty.call(inputs, 'text');
            const text = hasIncomingText ? getPrimaryTextInput(inputs.text) : (node.data.text || '');
            const delimiter = delimiterInput?.value ?? node.data.delimiter ?? '';
            const parsedOutputCount = parseInt(outputCountInput?.value ?? node.data.outputCount ?? '1', 10);
            const removeEmptyLines = removeEmptyLinesInput?.checked === true;
            const mergeOutputEnabled = mergeOutputEnabledInput?.checked === true;
            const outputCount = mergeOutputEnabled
                ? 0
                : (Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 1);
            const rawParts = splitTextForTextSplitNode(text, delimiter, { removeEmptyLines });
            const parts = outputCount === 0 ? rawParts : rawParts.slice(0, outputCount);
            node.data.text = text;
            node.data.delimiter = delimiter;
            node.data.outputCount = outputCount;
            node.data.removeEmptyLines = removeEmptyLines;
            node.data.mergeOutputEnabled = mergeOutputEnabled;
            node.data.parts = parts;
            if (mergeOutputEnabled) {
                node.data.texts = parts.slice();
            } else {
                delete node.data.texts;
            }
            Object.keys(node.data).forEach((key) => {
                if (/^part_\d+$/.test(key)) delete node.data[key];
            });
            parts.forEach((part, index) => {
                node.data[`part_${index + 1}`] = part;
            });
            syncTextSplitNodeData(node.id);
            updateAllConnections();
            return mergeOutputEnabled ? { text: parts.slice() } : {};
        },
        TextDisplay: async (node, inputs) => {
            const text = getPrimaryTextInput(inputs.text);
            const display = documentRef.getElementById(`${node.id}-display`);
            if (display) {
                display.textContent = text || '当前无输入文本';
                node.data.text = text;
                updateAllConnections();
            }
        }
    };

    async function executeNode(node, inputs, signal, executionContext = {}) {
        if (node.type === 'ImageImport') {
            const imageValue = getImageImportOutputValue(node);
            if (!imageValue) {
                delete node.data.image;
                throw new Error('未导入图片');
            }
            node.data.image = imageValue;
            await refreshDependentImageResizePreviews(node.id);
            return;
        }

        if (node.type === 'ImageResize' && isRemoteImageUrl(inputs.image)) {
            throw new Error('URL 图片不支持连接到图片缩放节点');
        }

        if (node.type === 'ImageSave' && hasRemoteImageValue(inputs.image)) {
            throw new Error('URL 图片不支持连接到保存节点');
        }

        if ((node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') && hasRemoteImageInput(inputs)) {
            const configId = documentRef.getElementById(`${node.id}-apiconfig`)?.value || '';
            const modelCfg = state.models.find((model) => model.id === configId);
            const selectedProviderId = documentRef.getElementById(`${node.id}-provider`)?.value || node.providerId || '';
            const apiCfg = modelCfg ? getResolvedProviderForModel(modelCfg, state.providers, selectedProviderId) : null;
            const protocol = getEffectiveProtocol(modelCfg, apiCfg);
            if (protocol === 'google') {
                throw new Error('URL 图片仅支持 OpenAI 兼容参考图，当前模型不支持');
            }
        }

        const handler = nodeHandlers[node.type];
        if (handler) {
            return await handler(node, inputs, signal, executionContext);
        } else {
            console.warn(`No handler defined for node type: ${node.type}`);
        }
    }

    return {
        normalizeRunOptions,
        resolveExecutionPlan,
        topologicalSort,
        getCachedOutputValue,
        resumeVideoGeneration,
        executeNode,
        nodeHandlers
    };
}
