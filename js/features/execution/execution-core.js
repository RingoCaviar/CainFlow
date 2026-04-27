/**
 * 提供工作流执行所需的核心能力，包括拓扑排序、节点执行和运行时错误处理。
 */
import {
    buildGoogleChatRequest,
    buildGoogleImageRequest,
    buildOpenAiChatRequest,
    buildOpenAiImageRequest,
    extractImageResult,
    getEffectiveProtocol,
    resolveProviderUrl,
    validateOpenAiImageSize
} from './provider-request-utils.js';

export function createExecutionCoreApi({
    state,
    nodeConfigs,
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
    deleteImageAsset,
    dataURLtoBlob,
    blobToDataUrl,
    resizeImageData,
    autoSaveToDir,
    restoreImageResizePreview,
    refreshDependentImageResizePreviews,
    fitNodeToContent,
    getAbortMessage,
    updateAllConnections,
    getImageHistorySidebarActive = () => false
}) {
    function requestNodeFit(nodeId) {
        windowRef.requestAnimationFrame(() => {
            fitNodeToContent(nodeId, { allowShrink: true });
        });
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
        const trimmedText = rawText.trim();

        const isHtmlResponse = contentType.includes('text/html') || /^<!doctype html/i.test(trimmedText) || /^<html/i.test(trimmedText);
        if (isHtmlResponse) {
            const err = new Error('当前供应商返回的是网页页面，而不是 API JSON。请检查 API 地址是否填成了网站首页，而不是接口地址。');
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            applyUserFacingError(err, {
                title: 'API 地址配置错误',
                userMessage: '当前供应商返回的是网页 HTML，不是 API JSON。通常是 API 地址填成了网站首页，或缺少 `/v1` 之类的接口前缀。',
                suggestions: [
                    '检查供应商的 API 地址是否是文档提供的接口基址，而不是官网首页。',
                    '如果你在使用 OpenAI 兼容供应商，优先确认地址是否应为 `/v1` 结尾。',
                    '把当前地址复制到浏览器访问时如果看到网页后台界面，通常就说明地址配错了。'
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
            const err = new Error('当前供应商返回的不是有效 JSON，请检查接口兼容性或 API 地址。');
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            applyUserFacingError(err, {
                title: '响应格式不兼容',
                userMessage: '当前供应商返回的内容不是可解析的 JSON，可能是接口地址不对，或该服务并不兼容当前请求协议。',
                suggestions: [
                    '检查当前 endpoint 是否正确。',
                    '确认这个供应商是否真的兼容当前所选模型和协议。',
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
            throw new Error(`${sourceLabel}返回的内容不是图片`);
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

    function getImageGenerationError(apiCfg, result, modelCfg) {
        if (result?.error?.message) return `API 错误: ${result.error.message}`;

        if (getEffectiveProtocol(modelCfg, apiCfg) === 'google') {
            const candidate = result?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const hasTextOnlyResponse = parts.length > 0 && parts.every((part) => typeof part?.text === 'string' && !part?.inlineData?.data);
            if (candidate?.finishReason) {
                const finishReason = candidate.finishReason;
                if (finishReason === 'STOP' && hasTextOnlyResponse) return '模型已正常结束，但这次只返回了文本，没有返回图片。通常是当前模型或中转线路不支持图片输出，或本次请求被当成了文本生成。';
                if (finishReason === 'SAFETY') return '⚠️ 内容被安全过滤器拦截 (可能包含违规提示词或敏感动作)';
                if (finishReason === 'RECITATION') return '生成内容由于版权保护被拦截';
                return `生成停止原因: ${finishReason}`;
            }
            const blockReason = result?.promptFeedback?.blockReason || result?.promptFeedback?.gemini_block_reason || result?.gemini_block_reason;
            if (blockReason) {
                return blockReason === 'SAFETY'
                    ? '⚠️ 请求因违反安全策略被系统拦截 (SAFETY)'
                    : `请求被屏蔽: ${blockReason}`;
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

    function collectUpstreamNodeIds(targetNodeId) {
        if (!targetNodeId || !state.nodes.has(targetNodeId)) return null;

        const scopeNodeSet = new Set();

        function visit(nodeId) {
            if (scopeNodeSet.has(nodeId)) return;
            scopeNodeSet.add(nodeId);
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

    function buildConnectionMaps(scopeNodeSet, mode) {
        const incomingConnectionsByNode = Object.create(null);
        const inputConnectionsByNode = Object.create(null);

        scopeNodeSet.forEach((nodeId) => {
            const allIncoming = state.connections.filter((connection) => (
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
        } = buildConnectionMaps(scopeNodeSet, runOptions.mode);
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
        if (!node) return undefined;
        if (portName === 'image' && node.type === 'ImageImport') {
            return getImageImportOutputValue(node);
        }
        if (node.data && node.data[portName] !== undefined) {
            return node.data[portName];
        }

        if (portName === 'text') {
            if (node.type === 'TextInput') {
                return documentRef.getElementById(`${node.id}-text`)?.value;
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

        if (portName === 'image') {
            if (node.type === 'ImageResize') {
                return node.imageData || node.resizePreviewData || undefined;
            }

            if (node.type === 'ImagePreview' || node.type === 'ImageSave') {
                return node.imageData || undefined;
            }
        }

        return undefined;
    }

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value);
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function hasRemoteImageInput(inputs = {}) {
        return Object.values(inputs).some((value) => isRemoteImageUrl(value));
    }

    function getReferenceImageInputs(inputs = {}) {
        return ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']
            .map((key) => ({ key, value: inputs[key] }))
            .filter((entry) => typeof entry.value === 'string' && entry.value.trim());
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
            const sourceImage = inputs.image;
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
        ImageGenerate: async (node, inputs, signal) => {
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
                const apiCfg = state.providers.find((provider) => provider.id === modelCfg.providerId);
                if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

                const aspect = documentRef.getElementById(`${id}-aspect`).value;
                const selectedResolution = documentRef.getElementById(`${id}-resolution`).value;
                const customWidth = documentRef.getElementById(`${id}-custom-resolution-width`)?.value || '';
                const customHeight = documentRef.getElementById(`${id}-custom-resolution-height`)?.value || '';
                const customResolution = customWidth && customHeight ? `${customWidth}x${customHeight}` : '';
                const resolution = selectedResolution === 'custom' ? customResolution : selectedResolution;
                const searchEnabled = documentRef.getElementById(`${id}-search`).checked;
                const prompt = inputs.prompt || documentRef.getElementById(`${id}-prompt`).value;

                if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
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
                node.generationCompletedCount = Math.min(
                    generationCount,
                    Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0)
                );

                while (node.generationCompletedCount < generationCount) {
                    const nextGenerationIndex = node.generationCompletedCount + 1;
                    const requestBody = isGoogle
                        ? buildGoogleImageRequest({ prompt, inputs, aspect, resolution, searchEnabled })
                        : buildOpenAiImageRequest({ modelCfg, prompt, resolution, inputs });
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

                    node.data.image = imageData;
                    node.generationCompletedCount = nextGenerationIndex;
                    await refreshDependentImageResizePreviews(id);

                    await saveHistoryEntry({
                        nodeId: id,
                        image: imageData,
                        prompt,
                        model: modelCfg.name
                    });
                    if (getImageHistorySidebarActive()) renderHistoryList();
                }
            } catch (err) {
                if (isAbortLikeError(err, signal)) {
                    if (errorEl) {
                        errorEl.innerHTML = '';
                        errorEl.style.display = 'none';
                    }
                    throw err;
                }
                if (errorEl) {
                    const completedCount = Math.max(0, parseInt(node.generationCompletedCount || '0', 10) || 0);
                    const progressText = targetGenerationCount > 1
                        ? `<div>已成功 ${completedCount}/${targetGenerationCount} 次，本次失败不计入次数。</div>`
                        : '';
                    errorEl.innerHTML = `<strong>生成失败</strong>${progressText}${err.message}`;
                    errorEl.style.display = 'block';
                    requestNodeFit(id);
                }
                throw err;
            }
        },
        TextChat: async (node, inputs, signal) => {
            const { id } = node;
            const configId = documentRef.getElementById(`${id}-apiconfig`).value;
            const modelCfg = state.models.find((model) => model.id === configId);
            if (!modelCfg) throw new Error('未找到选定的模型配置');
            const apiCfg = state.providers.find((provider) => provider.id === modelCfg.providerId);
            if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

            const sysprompt = documentRef.getElementById(`${id}-sysprompt`).value;
            const prompt = inputs.prompt || documentRef.getElementById(`${id}-prompt`).value;
            const fixedToggle = documentRef.getElementById(`${id}-fixed`);
            const isFixed = fixedToggle ? fixedToggle.checked : false;

            if (isFixed && node.isSucceeded && node.data && node.data.text) {
                return;
            }

            const responseArea = documentRef.getElementById(`${id}-response`);

            if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
            if (!prompt) throw new Error('请输入提问内容');

            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
            responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';

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
                if (windowRef.marked && windowRef.marked.parse) {
                    responseArea.innerHTML = windowRef.marked.parse(responseText);
                } else {
                    responseArea.innerText = responseText;
                }
                node.data.text = responseText;
                node.lastResponse = responseArea.innerHTML;
                node.isSucceeded = true;

                updateAllConnections();
            } catch (err) {
                responseArea.innerHTML = `<div class="chat-response-placeholder" style="color:var(--accent-red)">失败: ${err.message}</div>`;
                throw err;
            }
        },
        ImagePreview: async (node, inputs) => {
            const { id } = node;
            const imgData = inputs.image;
            const previewContainer = documentRef.getElementById(`${id}-preview`);
            const controls = documentRef.getElementById(`${id}-controls`);
            const resolutionBadge = documentRef.getElementById(`${id}-res`);
            if (imgData) {
                node.previewZoom = 1;
                previewContainer.innerHTML = `<img src="${imgData}" alt="预览" style="cursor:pointer" draggable="false" />`;
                controls.style.display = 'flex';
                node.imageData = imgData;
                node.data.image = imgData;
                if (isInlineImageData(imgData)) {
                    await saveImageAsset(id, imgData);
                } else {
                    await deleteImageAsset(id);
                }
                await showResolutionBadge(id, imgData);
                await refreshDependentImageResizePreviews(id);
            } else {
                node.previewZoom = 1;
                node.imageData = null;
                delete node.data.image;
                previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
                controls.style.display = 'none';
                await deleteImageAsset(id);
                if (resolutionBadge) {
                    resolutionBadge.textContent = '';
                    resolutionBadge.style.display = 'none';
                }
                await refreshDependentImageResizePreviews(id);
            }
            requestNodeFit(id);
        },
        ImageSave: async (node, inputs) => {
            const { id } = node;
            const imgData = inputs.image;
            const savePreview = documentRef.getElementById(`${id}-save-preview`);
            const manualSaveBtn = documentRef.getElementById(`${id}-manual-save`);
            const viewFullBtn = documentRef.getElementById(`${id}-view-full`);
            const resolutionBadge = documentRef.getElementById(`${id}-res`);
            if (imgData) {
                node.imageData = imgData;
                node.data.image = imgData;
                savePreview.innerHTML = `<img src="${imgData}" alt="待保存" draggable="false" />`;
                await saveImageAsset(id, imgData);
                await showResolutionBadge(id, imgData);
                if (manualSaveBtn) manualSaveBtn.disabled = false;
                if (viewFullBtn) viewFullBtn.disabled = false;
                await autoSaveToDir(id, imgData);
                await refreshDependentImageResizePreviews(id);
            } else {
                node.imageData = null;
                delete node.data.image;
                savePreview.innerHTML = '<div class="save-preview-placeholder">无输入图片</div>';
                await deleteImageAsset(id);
                if (manualSaveBtn) manualSaveBtn.disabled = true;
                if (viewFullBtn) viewFullBtn.disabled = true;
                if (resolutionBadge) {
                    resolutionBadge.textContent = '';
                    resolutionBadge.style.display = 'none';
                }
                await refreshDependentImageResizePreviews(id);
            }
        },
        TextInput: async (node) => {
            node.data.text = documentRef.getElementById(`${node.id}-text`).value;
        },
        TextDisplay: async (node, inputs) => {
            const text = inputs.text || '';
            const display = documentRef.getElementById(`${node.id}-display`);
            if (display) {
                display.textContent = text || '当前无输入文本';
                node.data.text = text;
                updateAllConnections();
            }
        }
    };

    async function executeNode(node, inputs, signal) {
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

        if (node.type === 'ImageSave' && isRemoteImageUrl(inputs.image)) {
            throw new Error('URL 图片不支持连接到图片保存节点');
        }

        if ((node.type === 'ImageGenerate' || node.type === 'TextChat') && hasRemoteImageInput(inputs)) {
            const configId = documentRef.getElementById(`${node.id}-apiconfig`)?.value || '';
            const modelCfg = state.models.find((model) => model.id === configId);
            const apiCfg = modelCfg ? state.providers.find((provider) => provider.id === modelCfg.providerId) : null;
            const protocol = getEffectiveProtocol(modelCfg, apiCfg);
            if (protocol === 'google') {
                throw new Error('URL 图片仅支持 OpenAI 兼容参考图，当前模型不支持');
            }
        }

        const handler = nodeHandlers[node.type];
        if (handler) {
            await handler(node, inputs, signal);
        } else {
            console.warn(`No handler defined for node type: ${node.type}`);
        }
    }

    return {
        normalizeRunOptions,
        resolveExecutionPlan,
        topologicalSort,
        getCachedOutputValue,
        executeNode,
        nodeHandlers
    };
}
