/**
 * 图片/视频异步任务执行模块。
 *
 * 这里集中处理“创建任务 -> 轮询任务 -> 恢复任务 -> 写回节点状态”的链路，
 * 避免把各供应商的异步细节继续堆在 execution-core.js 里。
 */
import {
    buildDoubaoVideoRequest,
    buildNewApiAsyncImageRequest,
    buildOpenAiVideoRequest,
    buildUnifiedVideoRequest,
    extractAsyncImageResult,
    extractAsyncImageStatus,
    extractAsyncImageTaskId,
    extractVideoResult,
    extractVideoStatus,
    extractVideoTaskId,
    getEffectiveProtocol,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    resolveProviderUrl
} from './provider-request-utils.js';
import { getPrimaryTextInput } from './execution-data-utils.js';
import { escapeHtml } from '../../core/common-utils.js';

export function createAsyncMediaExecutionApi({
    state,
    documentRef = document,
    windowRef = window,
    fetchRef = fetch,
    addLog,
    recordNodeRequest = () => {},
    getProxyHeaders,
    classifyProviderError,
    logRequestToPanel,
    formatProxyErrorMessage,
    parseJsonResponseOrThrow,
    recoverImageResultFromFailedResponse = async () => null,
    buildProviderErrorContext,
    applyUserFacingError,
    downloadGeneratedImage,
    downloadGeneratedVideo,
    blobToDataUrl,
    commitImageGenerateOutputs,
    renderNodeApiGenerationProgress,
    incrementNodeApiGenerationProgress,
    completeNodeApiGenerationProgress,
    saveImageGenerationHistoryEntry,
    saveVideoGenerationHistoryEntry = async () => {},
    getNodeGenerationDurationSeconds,
    getImageHistorySidebarActive = () => false,
    renderHistoryList,
    refreshDependentImageResizePreviews,
    updateAllConnections,
    scheduleSave = () => {},
    requestNodeFit = () => {}
}) {
    function recordProviderNodeRequest(node, apiCfg, modelCfg, url, responseOrOptions = {}, options = {}) {
        const response = responseOrOptions && typeof responseOrOptions === 'object' && 'ok' in responseOrOptions
            ? responseOrOptions
            : null;
        const finalOptions = response ? options : responseOrOptions;
        recordNodeRequest({
            nodeId: node?.id || '',
            nodeType: node?.type || finalOptions?.nodeType || '',
            providerId: apiCfg?.id || '',
            providerName: apiCfg?.name || apiCfg?.id || '',
            modelName: modelCfg?.name || modelCfg?.modelId || '',
            url,
            status: response ? response.status : finalOptions?.status,
            success: response ? response.ok : finalOptions?.success === true
        });
    }

    function createProviderRequestOutcomeRecorder(node, apiCfg, modelCfg, url, options = {}) {
        let recorded = false;
        return (success, extra = {}) => {
            if (recorded) return;
            recorded = true;
            recordProviderNodeRequest(node, apiCfg, modelCfg, url, {
                ...options,
                ...extra,
                success: success === true
            });
        };
    }

    async function runTrackedProviderRequest(node, apiCfg, modelCfg, url, requestFn, options = {}) {
        const recordOutcome = createProviderRequestOutcomeRecorder(node, apiCfg, modelCfg, url, options);
        try {
            const result = await requestFn();
            recordOutcome(true);
            return result;
        } catch (error) {
            const status = Number(error?.serverResponse?.status);
            recordOutcome(false, {
                status: Number.isFinite(status) ? status : undefined
            });
            throw error;
        }
    }

    function updateVideoGenerationStatus(nodeId, text, stateName = 'progress') {
        const statusEl = documentRef.getElementById(`${nodeId}-video-status`);
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = `video-generation-status video-generation-status-${stateName}`;
        requestNodeFit(nodeId);
    }

    function updateAsyncImageGenerationStatus(nodeId, text, stateName = 'progress') {
        const statusEl = documentRef.getElementById(`${nodeId}-image-async-status`);
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = `video-generation-status video-generation-status-${stateName}`;
        requestNodeFit(nodeId);
    }

    function classifyVideoUrlForLog(videoUrl = '') {
        const value = String(videoUrl || '').trim();
        if (!value) return { kind: 'empty', label: '空链接' };
        try {
            const parsed = new URL(value, windowRef.location?.href || 'http://localhost');
            const host = String(parsed.hostname || '').toLowerCase();
            const query = String(parsed.search || '');
            const isSigned = query.includes('Signature=') || query.includes('Expires=')
                || query.includes('response-content-disposition=')
                || host.includes('flow-content.google')
                || host.includes('storage.googleapis.com');
            return {
                kind: isSigned ? 'signed-video-direct' : 'normal-video-url',
                label: isSigned ? '签名视频直链' : '普通视频链接'
            };
        } catch (_) {
            return { kind: 'unknown-video-url', label: '未知视频链接' };
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

    function stripVideoHistoryPayload(result = {}) {
        const { videoBlob, ...safeResult } = result || {};
        return safeResult;
    }

    async function saveVideoGenerationToHistory(node, result, modelCfg, signal) {
        if (!result?.videoUrl) return null;
        try {
            const videoBlob = result.videoBlob instanceof Blob
                ? result.videoBlob
                : await downloadGeneratedVideo(result.videoUrl, { signal });
            await saveVideoGenerationHistoryEntry({
                nodeId: node.id,
                video: videoBlob,
                videoBlob,
                videoUrl: result.videoUrl,
                videoId: result.videoId || '',
                videoMimeType: videoBlob?.type || 'video/mp4',
                videoSizeBytes: videoBlob?.size || 0,
                prompt: result.prompt || node.data?.prompt || '',
                model: modelCfg?.name || '',
                generationDurationSeconds: getNodeGenerationDurationSeconds(node)
            });
            addLog('info', '视频历史缓存完成', '视频结果已下载并写入历史记录缓存。', {
                nodeId: node.id,
                model: modelCfg?.name || '',
                videoId: result.videoId || '',
                videoUrl: result.videoUrl,
                videoSizeBytes: videoBlob?.size || 0
            });
            if (getImageHistorySidebarActive()) renderHistoryList();
            return videoBlob;
        } catch (error) {
            addLog('warning', '视频历史缓存失败', '视频已经生成成功并会继续传递给下游，但保存到历史记录时下载/写入失败。', {
                nodeId: node.id,
                model: modelCfg?.name || '',
                videoId: result?.videoId || '',
                videoUrl: result?.videoUrl || '',
                error: error?.message || String(error)
            });
            return null;
        }
    }

    function commitAsyncImageTaskState(node, payload = {}) {
        node.data = node.data || {};
        if (Object.prototype.hasOwnProperty.call(payload, 'imageTaskId')) node.data.imageTaskId = payload.imageTaskId || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'imageTaskStatus')) node.data.imageTaskStatus = payload.imageTaskStatus || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'imageTaskStatusText')) node.data.imageTaskStatusText = payload.imageTaskStatusText || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'imageTaskUrl')) node.data.imageTaskUrl = payload.imageTaskUrl || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'prompt')) node.data.prompt = payload.prompt || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'createHttpStatus')) node.data.imageTaskCreateHttpStatus = payload.createHttpStatus || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'createStatus')) node.data.imageTaskCreateStatus = payload.createStatus || '';
        if (Object.prototype.hasOwnProperty.call(payload, 'progress')) node.data.imageTaskProgress = payload.progress === undefined || payload.progress === null ? '' : String(payload.progress);

        const taskId = node.data.imageTaskId || '';
        const resumeIdInput = documentRef.getElementById(`${node.id}-resume-image-id`);
        if (resumeIdInput) resumeIdInput.value = taskId;
        const resumeBtn = documentRef.getElementById(`${node.id}-resume-image`);
        if (resumeBtn) resumeBtn.disabled = !String(taskId || '').trim();
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

    function waitForPollInterval(intervalMs, signal) {
        return new Promise((resolve, reject) => {
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

    async function pollVideoGeneration({
        node,
        apiCfg,
        modelCfg,
        protocol,
        videoId,
        signal,
        prompt
    }) {
        const maxAttempts = 180;
        const intervalMs = 10000;
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

            const pollResult = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
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
                    const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                    const err = new Error(formatProxyErrorMessage(response.status, t, '视频状态查询失败', errorContext));
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
                addLog('info', `视频轮询响应: ${modelCfg.name} (${attempt}/${maxAttempts})`, '已收到服务器返回', {
                    url,
                    method: 'GET',
                    status: response.status,
                    videoId,
                    pollAttempt: attempt,
                    responseBody: result
                });
                return { result, statusCode: response.status };
            }, { nodeType: 'VideoGenerate' }).catch(async (error) => {
                if (protocol === 'veo-unified' && Number(error?.serverResponse?.status) === 404 && attempt < Math.min(maxAttempts, max404Retries)) {
                    await waitForPollInterval(intervalMs, signal);
                    return null;
                }
                throw error;
            });
            if (!pollResult) continue;
            const { result } = pollResult;
            const status = extractVideoStatus(result, protocol);
            const extracted = extractVideoResult(result, protocol);
            const videoUrlMeta = classifyVideoUrlForLog(extracted.url);

            if (status === 'completed' || status === 'succeeded' || status === 'success' || extracted.url) {
                let finalUrl = extracted.url;
                if (finalUrl) {
                    addLog('info', `视频结果链接: ${modelCfg.name} (${attempt}/${maxAttempts})`, `已识别为${videoUrlMeta.label}`, {
                        videoId,
                        videoUrl: finalUrl,
                        videoUrlType: videoUrlMeta.kind,
                        videoUrlLabel: videoUrlMeta.label
                    });
                }
                if (protocol === 'veo-openai' && !finalUrl) {
                    const downloadUrl = resolveProviderUrl(apiCfg, modelCfg, 'video', {
                        action: 'download',
                        videoId
                    });
                    const blob = await downloadGeneratedVideo(downloadUrl, { signal });
                    finalUrl = URL.createObjectURL(blob);
                    return {
                        videoId,
                        videoUrl: finalUrl,
                        videoBlob: blob,
                        status,
                        statusText: `视频生成完成（任务 ${videoId}）`,
                        prompt,
                        statusUpdateTime: String(result?.status_update_time || result?.data?.status_update_time || '').trim()
                    };
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

            await waitForPollInterval(intervalMs, signal);
        }

        throw new Error('视频生成轮询超时，请稍后在供应商后台确认任务状态');
    }

    async function pollAsyncImageGeneration({
        node,
        apiCfg,
        modelCfg,
        imageTaskId,
        signal,
        prompt
    }) {
        const maxAttempts = 180;
        const intervalMs = 5000;
        const protocol = 'newapi-image-async';

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (signal?.aborted) {
                const abortError = new Error('Node run aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }

            const url = resolveProviderUrl(apiCfg, modelCfg, 'image', {
                action: 'query',
                imageTaskId
            });
            const headers = getProxyHeaders(url, 'GET', {
                Authorization: `Bearer ${apiCfg.apikey}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            });

            logRequestToPanel(
                `图片异步轮询请求: ${modelCfg.name} (${attempt}/${maxAttempts})`,
                url,
                {
                    method: 'GET',
                    taskId: imageTaskId,
                    pollAttempt: attempt,
                    pollIntervalMs: intervalMs
                },
                {
                    nodeType: 'ImageGenerate',
                    providerType: protocol,
                    imageTaskId,
                    pollAttempt: attempt
                }
            );

            const result = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
                const response = await fetchRef('/proxy', {
                    method: 'POST',
                    headers,
                    signal
                });

                if (!response.ok) {
                    const t = await response.text();
                    const recoveredResult = await recoverImageResultFromFailedResponse(t, response.headers.get('content-type') || '', {
                        apiCfg,
                        modelCfg,
                        url,
                        requestBody: null,
                        status: response.status
                    });
                    if (recoveredResult?.recoveredImage?.dataUrl) {
                        return {
                            imageTaskId,
                            imageData: recoveredResult.recoveredImage.dataUrl,
                            status: 'completed',
                            progress: 100,
                            statusText: `图片生成完成（任务 ${imageTaskId}，已从失败响应恢复）`,
                            prompt,
                            recovered: true,
                            recoverySource: recoveredResult.recoveredImage.source || 'backend'
                        };
                    }
                    addLog('warning', `图片异步轮询响应: ${modelCfg.name} (${attempt}/${maxAttempts})`, `服务器返回错误状态 ${response.status}`, {
                        url,
                        method: 'GET',
                        status: response.status,
                        imageTaskId,
                        pollAttempt: attempt,
                        body: t
                    });
                    const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                    const err = new Error(formatProxyErrorMessage(response.status, t, '图片异步状态查询失败', errorContext));
                    err.serverResponse = {
                        url,
                        requestBody: null,
                        status: response.status,
                        body: t
                    };
                    applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                    throw err;
                }

                return parseJsonResponseOrThrow(response, {
                    apiCfg,
                    modelCfg,
                    url,
                    requestBody: null
                });
            }, { nodeType: 'ImageGenerate' });
            if (result?.imageData) return result;
            addLog('info', `图片异步轮询响应: ${modelCfg.name} (${attempt}/${maxAttempts})`, '已收到服务器返回', {
                url,
                method: 'GET',
                imageTaskId,
                pollAttempt: attempt,
                responseBody: result
            });

            const status = extractAsyncImageStatus(result);
            const extracted = extractAsyncImageResult(result);
            const progress = result?.progress ?? result?.data?.progress ?? '';

            if (status === 'completed' || status === 'succeeded' || status === 'success' || extracted.url) {
                if (!extracted.url) {
                    throw new Error('图片异步任务已完成，但接口没有返回图片链接');
                }
                addLog('info', `图片异步结果链接: ${modelCfg.name}`, '已获取图片直链', {
                    imageTaskId,
                    imageUrl: extracted.url,
                    status
                });
                return {
                    imageTaskId,
                    imageUrl: extracted.url,
                    status: status || 'completed',
                    progress,
                    statusText: `图片生成完成（任务 ${imageTaskId}）`,
                    prompt
                };
            }

            if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
                const message = result?.error?.message || result?.error || result?.data?.error?.message || '';
                throw new Error(`图片异步生成失败，当前状态：${status || 'unknown'}${message ? `，原因：${message}` : ''}`);
            }

            await waitForPollInterval(intervalMs, signal);
        }

        throw new Error('图片异步生成轮询超时，请稍后使用任务 ID 恢复进度');
    }

    async function finalizeAsyncImageGeneration(node, finalResult, signal) {
        const imageData = finalResult.imageData || await (async () => {
            const imageBlob = await downloadGeneratedImage(finalResult.imageUrl, signal);
            return blobToDataUrl(imageBlob);
        })();
        if (finalResult.recovered) {
            addLog('warning', '图片异步响应兜底恢复成功', '图片异步任务返回失败状态，但后端恢复模块已从响应中提取出图片。', {
                nodeId: node.id,
                imageTaskId: finalResult.imageTaskId,
                recoverySource: finalResult.recoverySource || 'backend'
            });
        }
        commitImageGenerateOutputs(node, [imageData], finalResult.prompt || node.data?.prompt || '');
        commitAsyncImageTaskState(node, {
            imageTaskId: finalResult.imageTaskId,
            imageTaskStatus: finalResult.status || 'completed',
            imageTaskStatusText: finalResult.statusText || `图片生成完成（任务 ${finalResult.imageTaskId}）`,
            imageTaskUrl: finalResult.imageUrl || '',
            prompt: finalResult.prompt || node.data?.prompt || '',
            progress: finalResult.progress
        });
        await refreshDependentImageResizePreviews(node.id);
        await saveImageGenerationHistoryEntry({
            nodeId: node.id,
            image: imageData,
            prompt: finalResult.prompt || node.data?.prompt || '',
            model: finalResult.modelName || '',
            generationDurationSeconds: getNodeGenerationDurationSeconds(node)
        });
        if (getImageHistorySidebarActive()) renderHistoryList();
        updateAllConnections();
        return imageData;
    }

    async function runAsyncImageGeneration({
        node,
        inputs,
        signal,
        apiCfg,
        modelCfg,
        protocol,
        prompt,
        aspect,
        resolution,
        generationCount,
        concurrentRequestStatus = null
    }) {
        const id = node.id;
        const responseArea = documentRef.getElementById(`${id}-image-async-response`);
        const results = [];
        renderNodeApiGenerationProgress(node, { current: 0, total: generationCount });
        updateAsyncImageGenerationStatus(id, '创建中：正在提交图片异步任务...', 'progress');
        if (responseArea) {
            responseArea.innerHTML = '<div class="chat-response-placeholder">正在提交图片异步任务...</div>';
        }

        for (let index = 0; index < generationCount; index += 1) {
            try {
                const url = resolveProviderUrl(apiCfg, modelCfg, 'image', { action: 'create', inputs });
                const requestBody = buildNewApiAsyncImageRequest({
                    modelCfg,
                    prompt,
                    aspect,
                    resolution,
                    inputs
                });
                const headers = getProxyHeaders(url, 'POST', {
                    Authorization: `Bearer ${apiCfg.apikey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                });

                logRequestToPanel(
                    generationCount > 1 ? `图片异步请求发送: ${modelCfg.name} (${index + 1}/${generationCount})` : `图片异步请求发送: ${modelCfg.name}`,
                    url,
                    requestBody,
                    {
                        nodeId: id,
                        nodeType: 'TextToImage',
                        providerType: protocol
                    }
                );

                const createResponseContext = {
                    apiCfg,
                    modelCfg,
                    url,
                    requestBody
                };
                const createResultPayload = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
                    const response = await fetchRef('/proxy', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(requestBody),
                        signal
                    });

                    if (!response.ok) {
                        const t = await response.text();
                        const recoveredResult = await recoverImageResultFromFailedResponse(t, response.headers.get('content-type') || '', {
                            apiCfg,
                            modelCfg,
                            url,
                            requestBody,
                            status: response.status
                        });
                        if (recoveredResult?.recoveredImage?.dataUrl) {
                            return {
                                recoveredImage: recoveredResult.recoveredImage,
                                responseStatus: response.status
                            };
                        }
                        const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                        const err = new Error(formatProxyErrorMessage(response.status, t, '图片异步任务创建失败', errorContext));
                        err.serverResponse = {
                            url,
                            requestBody,
                            status: response.status,
                            body: t
                        };
                        applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                        throw err;
                    }

                    const createResult = await parseJsonResponseOrThrow(response, createResponseContext);
                    const imageTaskId = extractAsyncImageTaskId(createResult);
                    if (!imageTaskId) throw new Error('图片异步任务创建成功，但接口没有返回任务 ID');
                    return {
                        createResult,
                        imageTaskId,
                        responseStatus: response.status
                    };
                }, { nodeType: 'ImageGenerate' });
                if (createResultPayload.recoveredImage?.dataUrl) {
                    const imageData = await finalizeAsyncImageGeneration(node, {
                        imageTaskId: `recovered:${Date.now()}`,
                        imageData: createResultPayload.recoveredImage.dataUrl,
                        status: 'completed',
                        progress: 100,
                        statusText: '图片生成完成（已从失败响应恢复）',
                        prompt,
                        recovered: true,
                        recoverySource: createResultPayload.recoveredImage.source || 'backend',
                        modelName: modelCfg.name
                    }, signal);
                    results.push({
                        imageTaskId: createResultPayload.recoveredImage.id || `recovered:${Date.now()}`,
                        imageUrl: '',
                        imageData,
                        status: 'completed'
                    });
                    incrementNodeApiGenerationProgress(node, 1, {
                        current: results.length,
                        total: generationCount
                    });
                    concurrentRequestStatus?.markRequestStatus?.(index, 'success');
                    continue;
                }
                const { createResult, imageTaskId, responseStatus } = createResultPayload;

                const createStatus = extractAsyncImageStatus(createResult) || 'submitted';
                const createProgress = createResult?.progress ?? createResult?.data?.progress ?? '';
                commitAsyncImageTaskState(node, {
                    imageTaskId,
                    imageTaskStatus: createStatus,
                    imageTaskStatusText: `创建中：任务 ${imageTaskId} 已创建，等待轮询`,
                    imageTaskUrl: '',
                    prompt,
                    createHttpStatus: responseStatus,
                    createStatus,
                    progress: createProgress
                });

                if (responseArea) {
                    responseArea.innerHTML = `
                        <div><strong>图片异步创建响应</strong></div>
                        <div>HTTP 状态：${escapeHtml(String(responseStatus))}</div>
                        <div>任务 ID：${escapeHtml(imageTaskId)}</div>
                        <div>创建状态：${escapeHtml(createStatus)}</div>
                        ${createProgress !== '' ? `<div>进度：${escapeHtml(String(createProgress))}</div>` : ''}
                        <div style="margin-top:6px;color:var(--text-dim);">创建完成后将继续自动轮询图片状态。</div>
                    `;
                }
                scheduleSave();
                updateAsyncImageGenerationStatus(
                    id,
                    generationCount > 1
                        ? `轮询中：第 ${index + 1}/${generationCount} 个任务已创建，正在检查状态`
                        : `轮询中：任务 ${imageTaskId} 已创建，正在检查状态`,
                    'progress'
                );

                const finalResult = await pollAsyncImageGeneration({
                    node,
                    apiCfg,
                    modelCfg,
                    imageTaskId,
                    signal,
                    prompt
                });
                const imageData = await finalizeAsyncImageGeneration(node, {
                    ...finalResult,
                    modelName: modelCfg.name
                }, signal);
                results.push({
                    imageData,
                    imageUrl: finalResult.imageUrl,
                    imageTaskId,
                    status: finalResult.status
                });
                incrementNodeApiGenerationProgress(node, 1, { current: index + 1, total: generationCount });
                concurrentRequestStatus?.markRequestStatus?.(index, 'success');
            } catch (error) {
                concurrentRequestStatus?.markRequestStatus?.(index, 'failed', error);
                throw error;
            }
        }

        const completedImages = results.map((result) => result.imageData).filter(Boolean);
        commitImageGenerateOutputs(node, completedImages, prompt);
        const lastResult = results[results.length - 1] || {};
        commitAsyncImageTaskState(node, {
            imageTaskId: lastResult.imageTaskId || node.data?.imageTaskId || '',
            imageTaskStatus: lastResult.status || 'completed',
            imageTaskStatusText: generationCount > 1 ? `已完成：${generationCount} 张图片都已生成完成` : '已完成：图片生成成功',
            imageTaskUrl: lastResult.imageUrl || '',
            prompt
        });
        node.isSucceeded = true;
        completeNodeApiGenerationProgress(node, { current: generationCount, total: generationCount });
        updateAsyncImageGenerationStatus(id, generationCount > 1 ? `已完成：${generationCount} 张图片都已生成完成` : '已完成：图片生成成功', 'success');
        if (responseArea) {
            responseArea.innerHTML = results.map((result, index) => {
                const linkHtml = result.imageUrl
                    ? `<a href="${escapeHtml(result.imageUrl)}" target="_blank" rel="noreferrer">打开图片 ${index + 1}</a>`
                    : '图片地址待供应商提供';
                return `<div><strong>第 ${index + 1} 个结果</strong></div><div>${linkHtml}</div><div style="margin-top:4px;color:var(--text-dim);">任务 ID：${escapeHtml(result.imageTaskId || '')}</div>`;
            }).join('<hr />');
        }
        await refreshDependentImageResizePreviews(id);
        updateAllConnections();
        return {
            image: completedImages[completedImages.length - 1] || '',
            images: completedImages.slice()
        };
    }

    async function resumeAsyncImageGeneration(nodeId, signal = null) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'ImageGenerate') {
            throw new Error('未找到可恢复的图片生成节点');
        }

        const configId = documentRef.getElementById(`${nodeId}-apiconfig`)?.value || '';
        const modelCfg = state.models.find((model) => model.id === configId);
        if (!modelCfg) throw new Error('未找到选定的图片模型配置');

        const selectedProviderId = documentRef.getElementById(`${nodeId}-provider`)?.value || node.providerId || '';
        const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
        const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
        if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
        node.providerId = resolvedProviderId;

        const protocol = getEffectiveProtocol(modelCfg, apiCfg);
        if (protocol !== 'newapi-image-async') {
            throw new Error('当前模型没有选择 NEW API 原生异步模式');
        }

        const imageTaskId = String(node.data?.imageTaskId || documentRef.getElementById(`${nodeId}-resume-image-id`)?.value || '').trim();
        if (!imageTaskId) throw new Error('当前节点没有可恢复的任务 ID');

        const prompt = String(node.data?.prompt || documentRef.getElementById(`${nodeId}-prompt`)?.value || '').trim();
        const responseArea = documentRef.getElementById(`${nodeId}-image-async-response`);
        const resumeBtn = documentRef.getElementById(`${nodeId}-resume-image`);
        const resumeIdInput = documentRef.getElementById(`${nodeId}-resume-image-id`);
        if (resumeIdInput) resumeIdInput.value = imageTaskId;

        renderNodeApiGenerationProgress(node, { current: 0, total: 1 });
        updateAsyncImageGenerationStatus(nodeId, `轮询中：正在恢复任务 ${imageTaskId} 的状态...`, 'progress');
        if (responseArea) {
            responseArea.innerHTML = `<div class="chat-response-placeholder">正在恢复任务 ${escapeHtml(imageTaskId)} 的进度...</div>`;
        }
        if (resumeBtn) resumeBtn.disabled = true;

        try {
            const finalResult = await pollAsyncImageGeneration({
                node,
                apiCfg,
                modelCfg,
                imageTaskId,
                signal,
                prompt
            });
            const imageData = await finalizeAsyncImageGeneration(node, {
                ...finalResult,
                modelName: modelCfg.name
            }, signal);
            if (responseArea) {
                responseArea.innerHTML = `<div><strong>图片异步任务完成</strong></div><div>任务 ID：${escapeHtml(imageTaskId)}</div><div style="margin-top:6px;"><a href="${escapeHtml(finalResult.imageUrl)}" target="_blank" rel="noreferrer">打开图片结果</a></div>`;
            }
            updateAsyncImageGenerationStatus(nodeId, finalResult.statusText || `已完成：任务 ${imageTaskId} 已恢复`, 'success');
            completeNodeApiGenerationProgress(node, { current: 1, total: 1 });
            scheduleSave();
            return {
                image: imageData,
                images: [imageData]
            };
        } finally {
            if (resumeBtn) resumeBtn.disabled = false;
        }
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
                node,
                apiCfg,
                modelCfg,
                protocol,
                videoId,
                signal,
                prompt
            });
            if (finalResult.videoUrl) {
                updateVideoGenerationStatus(nodeId, `下载中：任务 ${videoId} 已完成，正在缓存视频...`, 'progress');
                if (responseArea) {
                    responseArea.innerHTML = `${buildVideoCreateResponseHtml({
                        httpStatus: node.data?.videoCreateHttpStatus || '',
                        videoId: node.data?.videoId || videoId,
                        status: finalResult.status || node.data?.videoCreateStatus || '',
                        statusUpdateTime: finalResult.statusUpdateTime || node.data?.videoStatusUpdateTime || '',
                        enhancedPrompt: node.data?.videoEnhancedPrompt || ''
                    })}<div style="margin-top:8px;"><a href="${escapeHtml(finalResult.videoUrl)}" target="_blank" rel="noreferrer">打开视频结果</a></div><div style="margin-top:6px;">正在下载并缓存视频，完成后会继续运行下游节点...</div>`;
                }
            }
            const cachedVideoBlob = await saveVideoGenerationToHistory(node, finalResult, modelCfg, signal);
            if (cachedVideoBlob instanceof Blob && !(finalResult.videoBlob instanceof Blob)) {
                finalResult.videoBlob = cachedVideoBlob;
            }
            const safeFinalResult = stripVideoHistoryPayload(finalResult);
            commitVideoGenerateOutputs(node, safeFinalResult);
            if (safeFinalResult.videoUrl) {
                node.data.videos = [{
                    videoId: safeFinalResult.videoId || videoId,
                    videoUrl: safeFinalResult.videoUrl,
                    status: safeFinalResult.status || 'completed',
                    statusText: safeFinalResult.statusText || '',
                    prompt,
                    statusUpdateTime: safeFinalResult.statusUpdateTime || ''
                }];
            } else {
                delete node.data.videos;
            }
            if (responseArea) {
                responseArea.innerHTML = safeFinalResult.videoUrl
                    ? `${buildVideoCreateResponseHtml({
                        httpStatus: node.data?.videoCreateHttpStatus || '',
                        videoId: node.data?.videoId || videoId,
                        status: node.data?.videoCreateStatus || safeFinalResult.status || '',
                        statusUpdateTime: safeFinalResult.statusUpdateTime || node.data?.videoStatusUpdateTime || '',
                        enhancedPrompt: node.data?.videoEnhancedPrompt || ''
                    })}<div style="margin-top:8px;"><a href="${escapeHtml(safeFinalResult.videoUrl)}" target="_blank" rel="noreferrer">打开视频结果</a></div><div style="margin-top:6px;">${escapeHtml(safeFinalResult.statusText || '')}</div>`
                    : `${buildVideoCreateResponseHtml({
                        httpStatus: node.data?.videoCreateHttpStatus || '',
                        videoId: node.data?.videoId || videoId,
                        status: node.data?.videoCreateStatus || safeFinalResult.status || '',
                        statusUpdateTime: safeFinalResult.statusUpdateTime || node.data?.videoStatusUpdateTime || '',
                        enhancedPrompt: node.data?.videoEnhancedPrompt || ''
                    })}<div style="margin-top:6px;" class="chat-response-placeholder">${escapeHtml(safeFinalResult.statusText || '任务已恢复')}</div>`;
            }
            updateVideoGenerationStatus(nodeId, safeFinalResult.statusText || `已完成：任务 ${videoId} 已恢复`, 'success');
            completeNodeApiGenerationProgress(node, { current: 1, total: 1 });
            if (downloadBtn) downloadBtn.disabled = !safeFinalResult.videoUrl;
            updateAllConnections();
            scheduleSave();
            return safeFinalResult;
        } finally {
            if (resumeBtn) resumeBtn.disabled = false;
        }
    }

    async function runVideoGenerateNode(node, inputs, signal) {
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

        const userPrompt = (getPrimaryTextInput(inputs.prompt) || documentRef.getElementById(`${id}-prompt`)?.value || '').trim();
        const systemPrompt = (documentRef.getElementById(`${id}-param-systemPrompt`)?.value || node?.data?.protocolParams?.systemPrompt || '').trim();
        const prompt = systemPrompt ? systemPrompt + '\n' + userPrompt : userPrompt;
        const aspect = documentRef.getElementById(`${id}-aspect`)?.value || '16:9';
        const useVideoSizeParam = documentRef.getElementById(`${id}-use-size-param`)?.checked === true;
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
            const useSizeParam = (protocol === 'veo-unified' || protocol === 'veo-openai') && useVideoSizeParam;
            const requestBody = protocol === 'veo-openai'
                ? buildOpenAiVideoRequest({ modelCfg, prompt, aspectRatio: aspect, useSizeParam, inputs })
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
                    : buildUnifiedVideoRequest({ modelCfg, prompt, aspectRatio: aspect, useSizeParam, enhancePrompt, enableUpsample, inputs }));
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

            const createResponseContext = {
                apiCfg,
                modelCfg,
                url,
                requestBody
            };
            const createResultPayload = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
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
                    applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                    throw err;
                }

                const createResult = await parseJsonResponseOrThrow(response, createResponseContext);
                const videoId = extractVideoTaskId(createResult, protocol);
                if (!videoId) throw new Error('视频创建成功，但接口没有返回任务 ID');
                return {
                    createResult,
                    videoId,
                    responseStatus: response.status
                };
            }, { nodeType: 'VideoGenerate' });
            const { createResult, videoId, responseStatus } = createResultPayload;
            const createSummary = getVideoCreateResponseSummary(createResult, videoId);
            commitVideoGenerateOutputs(node, {
                videoId: createSummary.videoId || videoId,
                videoUrl: '',
                status: createSummary.status || 'submitted',
                statusText: `创建中：任务 ${createSummary.videoId || videoId} 已创建，等待轮询`,
                prompt,
                createHttpStatus: responseStatus,
                createStatus: createSummary.status,
                statusUpdateTime: createSummary.statusUpdateTime,
                enhancedPrompt: createSummary.enhancedPrompt
            });

            if (responseArea) {
                responseArea.innerHTML = buildVideoCreateResponseHtml({
                    httpStatus: responseStatus,
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
                node,
                apiCfg,
                modelCfg,
                protocol,
                videoId: createSummary.videoId || videoId,
                signal,
                prompt
            });
            await saveVideoGenerationToHistory(node, finalResult, modelCfg, signal);
            results.push(stripVideoHistoryPayload(finalResult));
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
    }

    return {
        runAsyncImageGeneration,
        runVideoGenerateNode,
        resumeAsyncImageGeneration,
        resumeVideoGeneration
    };
}
