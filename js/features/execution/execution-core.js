import { buildVisualStylePrompt, normalizeVisualStyle, resolveVisualStyle, visualStyleKey, VISUAL_STYLE_FIELDS } from '../visual-style/visual-style.js';
import { resolveCommerceImageSetStyle } from '../ecommerce-image-set/commerce-art-direction.js';
import { analyzeVisualStyle } from '../visual-style/visual-style-analysis.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { readImageResizeSettings } from '../../nodes/image-resize-settings.js';
import { validateUniversalImageInputs } from '../../nodes/universal-input-policy.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { normalizePromptImageMentions, resolvePromptImageMentions } from '../../nodes/prompt-image-mentions.js';
import { resolveGenerationInputProjection } from '../../nodes/generation-input-projection.js';
import { applyImageSaveMediaState, resolveImagePreviewInputState } from '../media/image-display-input-state.js';
import { applyThinking, resolveThinking } from './thinking-config.js';
/**
 * 提供工作流执行所需的核心能力，包括拓扑排序、节点执行和运行时错误处理。
 */
import {
    buildGoogleImageRequest,
    buildDoubaoVideoRequest,
    buildOpenAiImageRequest,
    buildNewApiAsyncImageRequest,
    buildOpenAiVideoRequest,
    buildTtapiImageRequest,
    buildTtapiOpenAiImageRequest,
    buildUnifiedVideoRequest,
    extractImageResult,
    getEffectiveProtocol,
    getOpenAiImageContents,
    getOpenAiReferenceImages,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    resolveProviderUrl
} from './provider-request-utils.js';
import { resolveImageRequestSize } from './image-generation-size.js';
import { resolveCommerceImageGenerationSettings } from './commerce-run-preflight.js';
import { getOpenAiImageCapabilities } from './openai-image-capabilities.js';
import { createChatRequestPlan, executeChatRequestPlan, requestChatCompletion } from './chat-request-plan.js';
import {
    appendReferenceImages,
    clearCanonicalImageOutput,
    coerceCustomParamValue,
    getCanonicalImage,
    getCanonicalImageList,
    getImageImportMediaAssetReferences,
    getPrimaryImageInput,
    getPrimaryTextInput,
    getTextInputList,
    normalizeImageList,
    setCanonicalImageOutput
} from './execution-data-utils.js';
import { isMultiConnectionInput, MAX_REFERENCE_IMAGE_COUNT, orderInputConnections } from '../../nodes/reference-image-ports.js';
import { appendReferenceDescriptions } from './reference-image-description.js';
import { escapeHtml, splitTextForTextSplitNode } from '../../core/common-utils.js';
import { generateCameraPrompt } from '../camera/camera-prompt-utils.js';
import { createAsyncMediaExecutionApi } from './async-media-execution.js';
import { getProtocolSnapshot } from './protocols/index.js';
import { compileVideoProtocol, redactProtocolPreview } from './protocols/video-protocol-compiler.js';
import { rememberWorkflowMediaOperation } from '../media/workflow-media-operation.js';
import { getCommerceOutputAssetKey, orderCommerceOutputRows } from '../ecommerce-image-set/commerce-detail-page.js';
import { buildCommerceShotReferenceInstructions, commerceConnectedStyleRevision, hasCommerceStyleReferenceChange,
    projectCommerceStyleReferences, readCommerceShotReferences } from '../ecommerce-image-set/commerce-shot-references.js';
import { projectMissingMediaAssets } from '../media/missing-media-integrity.js';
import { persistVideoResultForNode } from '../media/video/video-result-persistence.js';
import { readColorResetConfig } from '../media/color-reset-config.js';
import { getNodeImageResultPersistence, IMAGE_RESULT_PERSISTENCE } from '../../nodes/registry.js';
import { resolveWorkflowExecutionPlan } from './workflow-execution-plan.js';
import { buildOpenAiImageEditFormData, getOpenAiImageEditFields } from './openai-image-edit-form.js';
import { sanitizeRequestUrl } from '../../services/api-client.js';
import {
    analyzeCommerceImageSetProduct,
    buildCommerceImageSetImagePrompt,
    COMMERCE_SCENE_DESCRIPTION_LIMIT,
    commerceImageSetPlanningSettingsKey,
    commerceImageSetReferenceContentKey,
    commerceImageSetSourceKey,
    commerceShotPlanKey,
    confirmCommerceSceneShot,
    createCommerceImageSetPlan,
    getCommerceShotCandidates, getGeneratableCommerceImageSetShots, getRunnableCommerceImageSetShots,
    getUnfinishedCommerceImageSetShots, isCommerceShotFinalized,
    normalizeCommerceImageSetCandidateCount, normalizeCommerceImageSetState,
    rememberCommerceShotCandidate, removeCommerceSceneShot, restoreCommerceShotCandidateDraft, reviseCommerceDetailPage
} from '../ecommerce-image-set/commerce-image-set-plan.js';
import {
    COMMERCE_REFERENCE_CHANGED_MESSAGE, getCommerceReferenceRevision,
    hasCommerceReferenceChange, needsCommerceReferenceVerification, projectCommerceReferences,
    sameCommerceReferenceProjection, verifyCommerceReferenceContent
} from '../ecommerce-image-set/commerce-reference-revision.js';
import {
    buildProductRetouchPrompt,
    createProductRetouchAnalysisRequest,
    getProductRetouchAnalysisModelOptions,
    getProductRetouchModelOptions,
    normalizeProductRetouchSettings,
    parseProductRetouchAnalysis
} from '../product-retouch/product-retouch-settings.js';

const commerceActions = new Set(['analyze', 'plan', 'replan-shot', 'generate', 'fill', 'retry', 'generate-candidates', 'select-candidate', 'revise-detail-page']);

function getRemainingCommerceOutputPositions(settings, shotId, assetKeys) {
    const current = orderCommerceOutputRows(settings).filter(row => row.status === 'completed')
        .map(row => ({ shotId: row.shotId, key: getCommerceOutputAssetKey(row) }));
    const previous = (settings.previousExportResults || []).slice().sort((a, b) => a.order - b.order)
        .map(row => ({ shotId: row.shotId, key: row.outputKey }));
    const ordered = [current, previous].find(rows =>
        rows.length === assetKeys.length && rows.every((row, index) => row.key === assetKeys[index]));
    const keep = new Set();
    const remove = new Set();
    for (const row of [...current, ...previous]) {
        (row.shotId === shotId ? remove : keep).add(row.key);
    }
    return assetKeys.flatMap((key, index) => {
        const deleted = ordered ? ordered[index].shotId === shotId : remove.has(key) && !keep.has(key);
        return deleted ? [] : [index];
    });
}

function setRemainingCommerceOutput(node, positions, assetKeys, images) {
    clearCanonicalImageOutput(node);
    node.data.mediaAssetKeys = assetKeys;
    const integrity = node.data.mediaIntegrity;
    const missingItems = (integrity?.missingItems || []).flatMap(item => {
        const position = positions.indexOf(item.position);
        return position < 0 ? [] : [{ ...item, position }];
    });
    if (missingItems.length) node.data.mediaIntegrity = { ...integrity, itemCount: assetKeys.length, missingItems };
    else delete node.data.mediaIntegrity;
    if (images.length && images.every(Boolean)) {
        setCanonicalImageOutput(node, images, { defaultToFirst: true, assetKey: assetKeys[0],
            imageCount: assetKeys.length, assetReady: true });
    } else if (assetKeys.length) {
        node.data.imageAssetKey = assetKeys[0];
        node.data.imageCount = assetKeys.length;
        node.data.imageAssetReady = true;
        node.data.imageMemoryReleased = true;
    }
}

function syncReplannedCommerceOutput(node, settings) {
    const currentKeys = node.data.mediaAssetKeys || [];
    const targetKeys = orderCommerceOutputRows(settings).map(getCommerceOutputAssetKey).filter(Boolean);
    const cached = projectImageOutput(node, getCanonicalImageList(node)).images;
    if (currentKeys.length === targetKeys.length && targetKeys.every((key, index) => key === currentKeys[index])
        && (targetKeys.length || !cached.length)) return;
    const positions = targetKeys.map(key => currentKeys.indexOf(key));
    setRemainingCommerceOutput(node, positions, targetKeys, positions.map(index => cached[index]));
}

export function createExecutionCoreApi({
    state,
    referenceImageCatalog = null,
    nodeConfigs,
    syncTextSplitNodeData = () => {},
    documentRef = document,
    windowRef = window,
    fetchRef = fetch,
    showToast,
    addLog,
    recordNodeRequest = () => {},
    getProxyHeaders,
    classifyProviderError,
    logRequestToPanel,
    formatProxyErrorMessage,
    saveHistoryEntry,
    renderHistoryList,
    showResolutionBadge,
    getImageAsset = async () => null,
    saveWorkflowNodeMediaAsset = async () => null,
    saveWorkflowNodeMediaAssets = async () => [],
    releaseWorkflowNodeMediaAssets = async () => false,
    deleteImageAsset,
    dataURLtoBlob,
    blobToDataUrl,
    resizeImageData,
    processColorResetImage,
    autoSaveToDir,
    restoreImageResizePreview,
    restoreColorResetPreview = () => {},
    renderImagePreviewImage = () => {},
    releaseNodeImageData = async () => false,
    refreshDependentImageResizePreviews,
    syncImagePreviewNode = async () => {},
    syncImageSaveNode = async () => {},
    syncImageCompareNode,
    syncImageMergeNode = async () => {},
    syncCameraControlNode = () => '',
    fitNodeToContent,
    scheduleSave = () => {},
    getActiveWorkflowId = () => '',
    assertCommercePlanningCurrent = () => {},
    onNodeResultUpdated = () => {},
    getAbortMessage,
    connectionProjection = null,
    getImageHistorySidebarActive = () => false
}) {
    const sceneReferenceImages = new Map();
    const commerceBatches = new WeakMap();
    const commercePublications = new WeakMap();

    function canCaptureSceneReference(source) {
        return source.sourceNodeId && !source.connectionId && (!source.workflowId || source.workflowId === getActiveWorkflowId());
    }

    function captureSceneReferenceImages(plan, signal) {
        if (!referenceImageCatalog) return;
        const sources = new Map();
        const resetNodeIds = new Set(plan.mode === 'all' ? state.nodes.keys() : plan.scopeNodeSet || plan.executionOrder);
        for (const nodeId of plan.executionOrder || []) {
            for (const { source } of normalizePromptImageMentions(state.nodes.get(nodeId)?.data?.imagePromptMentions)) {
                if (canCaptureSceneReference(source) && resetNodeIds.has(source.sourceNodeId)) sources.set(source.id, source);
            }
        }
        if (!sources.size) return;
        return (async () => {
            for (const [id, source] of sources) {
                signal?.throwIfAborted();
                // Defer a missing/failed original to the specific node and prompt
                // that uses it, instead of failing an unrelated workflow branch.
                const image = await Promise.resolve().then(() => referenceImageCatalog.readImage(source, { state })).catch(() => '');
                signal?.throwIfAborted();
                sceneReferenceImages.set(id, image);
            }
        })();
    }

    const imageAssetSaveChains = new Map();
    const imageAssetSaveFailures = new WeakMap();

    async function propagateImagesToDownstreamPreview(sourceNodeId, images = []) {
        const imageList = normalizeImageList(images);
        if (!sourceNodeId || imageList.length === 0) return;
        const downstreamIds = (state.connections || [])
            .filter((conn) => conn.from?.nodeId === sourceNodeId && conn.from?.port === 'image')
            .map((conn) => conn.to?.nodeId)
            .filter((nodeId, index, list) => nodeId && list.indexOf(nodeId) === index);
        const results = await Promise.allSettled(downstreamIds.map(async (targetId) => {
            const targetNode = state.nodes.get(targetId);
            if (!targetNode) return;
            if (targetNode.type === 'ImagePreview') {
                await syncImagePreviewNode(targetId, imageList);
            } else if (targetNode.type === 'ImageSave') {
                await syncImageSaveNode(targetId, imageList);
            }
        }));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
    }

    function requestNodeFit(nodeId) {
        windowRef.requestAnimationFrame(() => {
            fitNodeToContent(nodeId);
        });
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
            if (node.type === 'ImageGenerate') onNodeResultUpdated(node.id, { progressOnly: true });
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
        if (node.type === 'ImageGenerate') onNodeResultUpdated(node.id, { progressOnly: true });
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
        if (node.type === 'ImageGenerate') onNodeResultUpdated(node.id, { progressOnly: true });
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

    function markNodeImageAssetPending(node, assetKey, imageCount = 1) {
        if (!node) return 0;
        node.data = node.data || {};
        if (assetKey) node.data.imageAssetKey = assetKey;
        if (typeof assetKey === 'string' && assetKey.startsWith('media:')) node.data.mediaAssetKeys = [assetKey];
        node.data.imageCount = Math.max(1, parseInt(imageCount, 10) || 1);
        delete node.data.imageAssetReady;
        delete node.data.imageMemoryReleased;
        const token = (parseInt(node.data.imageAssetSaveToken || '0', 10) || 0) + 1;
        node.data.imageAssetSaveToken = token;
        return token;
    }

    function markNodeImageAssetReady(node, assetKey, imageCount = 1, token = null) {
        if (!node) return false;
        node.data = node.data || {};
        if (token !== null && node.data.imageAssetSaveToken !== token) return false;
        if (assetKey) node.data.imageAssetKey = assetKey;
        node.data.imageCount = Math.max(1, parseInt(imageCount, 10) || 1);
        node.data.imageAssetReady = true;
        node.data.imageHydratedAt = Date.now();
        delete node.data.imageMemoryReleased;
        delete node.data.imageAssetSaveToken;
        return true;
    }

    function markNodeImageAssetFailed(node, token = null) {
        if (!node?.data) return;
        if (token !== null && node.data.imageAssetSaveToken !== token) return;
        delete node.data.imageAssetReady;
        delete node.data.imageAssetSaveToken;
    }

    function saveNodeImageAssetInBackground(node, images, assetKey = node?.id, signal = null) {
        const imageList = normalizeImageList(images);
        if (!node || !assetKey || imageList.length === 0) return;
        const workflowId = getActiveWorkflowId();
        const token = markNodeImageAssetPending(node, assetKey, imageList.length);
        imageAssetSaveFailures.delete(node);
        const runOperationId = node.activeMediaOperationId;
        const operationId = globalThis.crypto?.randomUUID?.()
            || `image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        if (node.activeMediaOperationId) {
            node.activeMediaOperationIds = node.activeMediaOperationIds || new Set();
            node.activeMediaOperationIds.add(operationId);
        }
        const reportSaveFailure = () => {
            if (node.data?.imageAssetSaveToken !== token || state.nodes.get(node.id) !== node) return;
            markNodeImageAssetFailed(node, token);
            imageAssetSaveFailures.set(node, {
                runOperationId,
                error: new Error('图片已生成，但本地媒体保存失败，请重试。')
            });
            showToast('图片已生成，但本地保存失败；关闭应用后可能无法恢复', 'warning');
            addLog('warning', '生成图片保存失败', '图片结果未能写入本地媒体存储，请检查存储空间并重新保存。', { nodeId: node.id });
        };
        const saveTask = async () => {
            const mediaAssets = imageList.length > 1 && workflowId
                ? await saveWorkflowNodeMediaAssets(imageList, workflowId, node.id, operationId)
                : [];
            const mediaAsset = imageList.length === 1 && workflowId
                ? await saveWorkflowNodeMediaAsset(imageList[0], workflowId, node.id, operationId)
                : null;
            if (workflowId && !mediaAsset?.asset_key && (mediaAssets.length !== imageList.length
                || mediaAssets.some(asset => !asset?.asset_key))) {
                reportSaveFailure();
                return;
            }
            const materializedAssets = mediaAsset ? [mediaAsset] : mediaAssets;
            if (signal?.aborted || state.nodes.get(node.id) !== node || node.data?.imageAssetSaveToken !== token) {
                await releaseWorkflowNodeMediaAssets(materializedAssets, workflowId, node.id);
                return;
            }
            const savedAssetKey = mediaAsset?.asset_key || mediaAssets[0]?.asset_key || assetKey;
            const saved = Boolean(mediaAsset || mediaAssets.length === imageList.length);
            if (saved) {
                rememberWorkflowMediaOperation(node, mediaAsset ? [mediaAsset] : mediaAssets);
                if (!markNodeImageAssetReady(node, savedAssetKey, imageList.length, token)) return;
                if (mediaAsset) node.data.mediaAssetKeys = [mediaAsset.asset_key];
                else if (mediaAssets.length === imageList.length) node.data.mediaAssetKeys = mediaAssets.map((asset) => asset.asset_key);
                delete node.data.imageResultPersistence;
                onNodeResultUpdated(node.id);
                try {
                    await propagateImagesToDownstreamPreview(node.id, imageList);
                } catch (error) {
                    console.warn('Updating downstream image nodes after persistence failed:', error);
                }
                scheduleSave();
            } else {
                reportSaveFailure();
            }
        };
        const previous = imageAssetSaveChains.get(assetKey) || Promise.resolve();
        const queued = previous
            .catch(() => {})
            .then(saveTask)
            .catch(reportSaveFailure);
        const tracked = queued.finally(() => {
            if (imageAssetSaveChains.get(assetKey) === tracked) {
                imageAssetSaveChains.delete(assetKey);
            }
        });
        imageAssetSaveChains.set(assetKey, tracked);
    }

    async function waitForPendingImageAssetSaves({ nodeId = null, requireSuccess = false } = {}) {
        while (imageAssetSaveChains.size > 0) {
            await Promise.allSettled([...imageAssetSaveChains.values()]);
        }
        // Cleanup/close callers only drain work. A generation attempt must also
        // validate its own outcome, even if its save settled before this wait.
        if (requireSuccess) {
            const node = state.nodes.get(nodeId);
            const failure = imageAssetSaveFailures.get(node);
            if (failure && failure.runOperationId === node.activeMediaOperationId) throw failure.error;
        }
    }

    async function saveNodeImageAssetNow(node, images, assetKey = node?.id) {
        const imageList = normalizeImageList(images);
        if (!node || !assetKey || imageList.length === 0) return false;
        const workflowId = getActiveWorkflowId();
        const token = markNodeImageAssetPending(node, assetKey, imageList.length);
        try {
            const previous = imageAssetSaveChains.get(assetKey);
            if (previous) await previous.catch(() => {});
            const mediaAssets = imageList.length > 1 && workflowId
                ? await saveWorkflowNodeMediaAssets(imageList, workflowId, node.id, node.activeMediaOperationId)
                : [];
            const mediaAsset = imageList.length === 1 && workflowId
                ? await saveWorkflowNodeMediaAsset(imageList[0], workflowId, node.id, node.activeMediaOperationId)
                : null;
            if (workflowId && !mediaAsset && mediaAssets.length !== imageList.length) {
                markNodeImageAssetFailed(node, token);
                return false;
            }
            const materializedAssets = mediaAsset ? [mediaAsset] : mediaAssets;
            if (state.nodes.get(node.id) !== node || node.data?.imageAssetSaveToken !== token) {
                await releaseWorkflowNodeMediaAssets(materializedAssets, workflowId, node.id);
                return false;
            }
            const savedAssetKey = mediaAsset?.asset_key || mediaAssets[0]?.asset_key || assetKey;
            const saved = Boolean(mediaAsset || mediaAssets.length === imageList.length);
            if (saved) {
                rememberWorkflowMediaOperation(node, mediaAsset ? [mediaAsset] : mediaAssets);
                if (!markNodeImageAssetReady(node, savedAssetKey, imageList.length, token)) return false;
                if (mediaAsset) node.data.mediaAssetKeys = [mediaAsset.asset_key];
                else if (mediaAssets.length === imageList.length) node.data.mediaAssetKeys = mediaAssets.map((asset) => asset.asset_key);
                await releaseNodeImageData(node.id);
                return true;
            }
        } catch {
            // Fall through to mark the current save as failed.
        }
        markNodeImageAssetFailed(node, token);
        return false;
    }

    function commitImageGenerateOutputs(node, images = [], prompt = '', signal = null) {
        const normalizedImages = normalizeImageList(images);
        setCanonicalImageOutput(node, normalizedImages, {
            currentIndex: normalizedImages.length - 1,
            assetKey: node.id,
            imagePromptList: normalizedImages.map(() => prompt || ''),
            imageCount: normalizedImages.length,
            assetReady: false
        });
        node.imagePromptList = normalizedImages.map(() => prompt || '');
        if (normalizedImages.length) node.data.visualStyleSnapshot = node.pendingVisualStyleSnapshot ? structuredClone(node.pendingVisualStyleSnapshot) : null;
        node.generationCompletedCount = normalizedImages.length;
        if (getNodeImageResultPersistence(node.type) === IMAGE_RESULT_PERSISTENCE.PERSISTENT && normalizedImages.length > 0) {
            node.data.imageResultPersistence = 'transient';
            delete node.data.mediaAssetKeys;
            saveNodeImageAssetInBackground(node, normalizedImages, node.id, signal);
        } else if (deleteImageAsset) {
            void deleteImageAsset(node.id);
            delete node.data.imageAssetKey;
            delete node.data.mediaAssetKeys;
            delete node.data.imageAssetReady;
        }
        if (normalizedImages.length > 0 && getNodeImageResultPersistence(node.type) !== IMAGE_RESULT_PERSISTENCE.PERSISTENT) {
            void propagateImagesToDownstreamPreview(node.id, normalizedImages).catch(() => {});
        }
    }

    function resetImageGenerateRunOutputs(node) {
        if (!node) return;
        clearCanonicalImageOutput(node);
        node.imagePromptList = [];
        node.generationCompletedCount = 0;
    }

    async function saveImageGenerationHistoryEntry(entry) {
        try {
            const result = await saveHistoryEntry(entry);
            if (result === false) throw new Error('保存目录写入失败');
            return result;
        } catch (error) {
            throw new Error(`图片已生成，但本地保存失败：${error.message || error}。请检查保存目录和磁盘空间。`, { cause: error });
        }
    }

    async function saveVideoGenerationHistoryEntry(entry) {
        try {
            const result = await saveHistoryEntry({ ...entry, mediaType: 'video' });
            if (result === false) throw new Error('保存目录写入失败');
            return result;
        } catch (error) {
            throw new Error(`视频已生成，但本地保存失败：${error.message || error}。请检查保存目录和磁盘空间。`, { cause: error });
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
        const proxy = state?.proxy && typeof state.proxy === 'object' ? state.proxy : null;
        let targetProtocol = '';
        let targetHost = '';
        let targetPort = '';
        try {
            const parsed = new URL(String(url || ''), windowRef.location?.href || 'http://localhost');
            targetProtocol = String(parsed.protocol || '').replace(/:$/, '');
            targetHost = String(parsed.hostname || '').trim();
            targetPort = String(parsed.port || '').trim();
        } catch {
            // Keep URL metadata empty; the raw URL is still included for logs and diagnostics.
        }
        return {
            providerType: protocol || 'unknown',
            url,
            providerEndpoint: apiCfg?.endpoint || '',
            targetProtocol,
            targetHost,
            targetPort,
            modelId: modelCfg?.modelId || '',
            providerId: apiCfg?.id || '',
            apiKeyShape: getApiKeyShape(apiCfg?.apikey),
            proxyEnabled: proxy?.enabled === true,
            proxyHost: String(proxy?.ip || proxy?.host || '').trim(),
            proxyPort: String(proxy?.port || '').trim()
        };
    }

    function applyUserFacingError(err, userFacing) {
        if (!err || !userFacing) return err;
        err.userFacing = userFacing;
        if (userFacing.userMessage) err.message = userFacing.userMessage;
        return err;
    }

    function extractFirstJsonText(text = '') {
        const source = String(text || '');
        const firstObject = source.indexOf('{');
        const firstArray = source.indexOf('[');
        const starts = [firstObject, firstArray].filter((index) => index >= 0);
        if (starts.length === 0) return '';

        const start = Math.min(...starts);
        const stack = [];
        let inString = false;
        let escaped = false;

        for (let index = start; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
            } else if (char === '{') {
                stack.push('}');
            } else if (char === '[') {
                stack.push(']');
            } else if (char === '}' || char === ']') {
                if (stack.pop() !== char) return '';
                if (stack.length === 0) return source.slice(start, index + 1);
            }
        }

        return '';
    }

    function tryParseEmbeddedJson(text = '') {
        const jsonText = extractFirstJsonText(text);
        if (!jsonText) return null;
        try {
            return JSON.parse(jsonText);
        } catch {
            return null;
        }
    }

    function shouldAttemptBackendImageRecovery(text = '', context = {}) {
        const protocol = getEffectiveProtocol(context.modelCfg, context.apiCfg);
        const url = String(context.url || '').toLowerCase();
        const source = String(text || '');
        const hasLongContent = source.length > 1200;
        const hasTruncatedContent = hasLongContent || /\[数据过长已截断\]|\[完整详情仍过长，已截断\]|\[truncated\s+\d+\s+chars\]|数据过长|truncated/i.test(source);
        if (!context.responseFailed && !hasTruncatedContent && protocol !== 'google' && !url.includes(':generatecontent') && !url.includes('/v1beta/models/')) {
            return false;
        }

        return (
            hasTruncatedContent ||
            /"inlineData"|"inline_data"|"b64_json"|"b64Json"|data:image\//i.test(source) &&
            /"data"\s*:|"b64_json"\s*:|"b64Json"\s*:|data:image\//i.test(source)
        );
    }

    async function recoverImageResponseWithBackend(text = '', contentType = '', context = {}) {
        if (!shouldAttemptBackendImageRecovery(text, context)) return null;
        try {
            const response = await fetchRef('/api/media/recover-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    body: text,
                    contentType,
                    providerType: getEffectiveProtocol(context.modelCfg, context.apiCfg) || '',
                    modelId: context.modelCfg?.modelId || ''
                })
            });
            const result = await response.json().catch(() => null);
            if (result?.attempted && (!result?.success || !result?.image?.dataUrl)) {
                addLog?.('info', '媒体响应兜底解析无结果', result.message || '媒体恢复模块已尝试解析服务器响应，但未发现可用的图片或媒体数据。', {
                    url: context.url,
                    status: context.status,
                    contentType,
                    recoveryError: result.error || '',
                    modelId: context.modelCfg?.modelId || '',
                    providerType: getEffectiveProtocol(context.modelCfg, context.apiCfg) || 'unknown'
                });
            }
            if (!response.ok || !result?.success || !result?.image?.dataUrl) return null;
            return {
                cainflowRecoveredImage: true,
                recoveredImage: result.image,
                recoveredFromFailedResponse: context.responseFailed === true,
                recoveredHttpStatus: context.status || null,
                data: [{
                    b64_json: String(result.image.dataUrl).split(',')[1] || ''
                }]
            };
        } catch (error) {
            console.warn('Backend image recovery failed:', error);
            return null;
        }
    }

    async function recoverImageResultFromFailedResponse(text = '', contentType = '', context = {}) {
        const recovered = await recoverImageResponseWithBackend(text, contentType, {
            ...context,
            responseFailed: true
        });
        if (!recovered?.cainflowRecoveredImage) return null;
        addLog?.('warning', '失败响应兜底恢复成功', '当前请求返回失败状态，但响应内容疑似包含被截断的媒体数据，后端恢复模块已尝试提取并恢复出图片。', {
            url: context.url,
            status: context.status,
            contentType,
            modelId: context.modelCfg?.modelId || '',
            providerType: getEffectiveProtocol(context.modelCfg, context.apiCfg) || 'unknown',
            recoverySource: recovered.recoveredImage?.source || 'backend'
        });
        return recovered;
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
            const errorContext = buildProviderErrorContext(context.apiCfg, context.modelCfg, context.url);
            const classified = classifyProviderError(response.status, rawText, errorContext);
            const isHumanVerification = classified?.category === 'cloudflare_challenge';
            const err = new Error(isHumanVerification
                ? classified.userMessage
                : '当前提供商返回的是网页 HTML，而不是 API JSON。请检查 API 地址是否填成了网站首页，而不是接口地址。'
            );
            err.serverResponse = {
                url: context.url,
                requestBody: context.requestBody,
                status: response.status,
                contentType,
                body: rawText
            };
            applyUserFacingError(err, isHumanVerification ? classified : {
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
                }
            );
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
            const embeddedJson = tryParseEmbeddedJson(trimmedText);
            if (embeddedJson) return embeddedJson;

            const recoveredImageResponse = await recoverImageResponseWithBackend(trimmedText, contentType, {
                ...context,
                status: response.status
            });
            if (recoveredImageResponse) return recoveredImageResponse;

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

    async function downloadGeneratedVideo(videoUrl, options = {}) {
        const signal = typeof AbortSignal !== 'undefined' && options instanceof AbortSignal
            ? options
            : options?.signal || null;
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

    function getImageGenerationError(apiCfg, result, modelCfg) {
        if (result?.error?.message) return `API 错误: ${result.error.message}`;
        if (typeof result?.error === 'string' && result.error.trim()) return `API 错误: ${result.error.trim()}`;
        if (typeof result?.message === 'string' && result.message.trim()) return `API 错误: ${result.message.trim()}`;
        if (typeof result?.msg === 'string' && result.msg.trim()) return `API 错误: ${result.msg.trim()}`;

        if (getEffectiveProtocol(modelCfg, apiCfg) === 'google') {
            const candidate = result?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const hasTextOnlyResponse = parts.length > 0 && parts.every((part) => typeof part?.text === 'string' && !(part?.inlineData || part?.inline_data)?.data);
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
        const { refreshTextChatNodeId } = runInput;
        const refreshTextChat = mode === 'selected-only' && selectedNodeIds.length === 1
            && selectedNodeIds[0] === refreshTextChatNodeId && state.nodes.get(refreshTextChatNodeId)?.type === 'TextChat';
        const commerceNodeId = runInput.commerceNodeId;
        const { commerceAction, commerceShotId, commerceCandidateKey, commerceCandidateCount, commerceDetailDirection } = runInput;
        if (commerceAction !== undefined && !commerceActions.has(commerceAction)) throw new Error('无效的电商套图操作。');
        const commerceTargeted = mode === 'selected-only' && selectedNodeIds.length === 1 && selectedNodeIds[0] === commerceNodeId
            && state.nodes.get(commerceNodeId)?.type === 'ECommerceImageSet'
            && commerceActions.has(commerceAction);
        if (commerceAction === 'revise-detail-page' || commerceDetailDirection !== undefined) {
            if (!commerceTargeted || commerceAction !== 'revise-detail-page' || (commerceShotId !== undefined
                && (typeof commerceShotId !== 'string' || !commerceShotId)) || typeof commerceDetailDirection !== 'string'
                || !commerceDetailDirection.trim() || commerceDetailDirection.length > COMMERCE_SCENE_DESCRIPTION_LIMIT) {
                throw new Error('请选择详情页或图位并填写有效的版式调整说明。');
            }
        }
        if (commerceAction === 'analyze' && !commerceTargeted) {
            throw new Error('请选择一个需要分析商品信息的电商套图节点。');
        }
        if (commerceAction === 'replan-shot' && (!commerceTargeted || typeof runInput.commerceShotId !== 'string' || !runInput.commerceShotId)) {
            throw new Error('请选择一个需要重新规划的图位。');
        }
        if (['retry', 'generate-candidates'].includes(commerceAction) && (!commerceTargeted || typeof runInput.commerceShotId !== 'string' || !runInput.commerceShotId)) {
            throw new Error('请选择一个需要生图的图位。');
        }
        if (commerceCandidateCount !== undefined && (!commerceTargeted || commerceAction !== 'generate-candidates'
            || commerceCandidateCount !== normalizeCommerceImageSetCandidateCount(commerceCandidateCount))) {
            throw new Error('请选择有效的候选图片张数。');
        }
        if (commerceAction === 'select-candidate' || commerceCandidateKey !== undefined) {
            const settings = state.nodes.get(commerceNodeId)?.data?.commerceImageSet;
            if (commerceAction !== 'select-candidate' || !commerceTargeted
                || !getCommerceShotCandidates(settings, commerceShotId).some(candidate => candidate.key === commerceCandidateKey)) {
                throw new Error('找不到所选图位的候选图片，请重新打开候选。');
            }
        }
        if (commerceAction === 'fill') {
            if (!commerceTargeted || runInput.commerceShotId !== undefined) throw new Error('请选择一个需要补齐的电商套图节点。');
            const settings = normalizeCommerceImageSetState(state.nodes.get(commerceNodeId).data?.commerceImageSet);
            if (settings.plan?.confirmed && !getUnfinishedCommerceImageSetShots(settings).length) throw new Error('所有图位已完成。');
        }
        const { visualStyleFields } = runInput;
        if (visualStyleFields !== undefined && (mode !== 'target-node' || state.nodes.get(targetNodeId)?.type !== 'VisualStyle'
            || !Array.isArray(visualStyleFields) || !visualStyleFields.length
            || visualStyleFields.some(key => !Object.hasOwn(VISUAL_STYLE_FIELDS, key)))) throw new Error('请选择画面风格节点和有效提取维度。');
        const { imageRetryNodeId, imageRetryIndex, imageRetryBatchId } = runInput;
        const imageRetry = imageRetryNodeId !== undefined || imageRetryIndex !== undefined || imageRetryBatchId !== undefined;
        if (imageRetry && (mode !== 'selected-only' || selectedNodeIds.length !== 1 || selectedNodeIds[0] !== imageRetryNodeId
            || state.nodes.get(imageRetryNodeId)?.type !== 'ImageGenerate' || !Number.isInteger(imageRetryIndex) || imageRetryIndex < 0
            || typeof imageRetryBatchId !== 'string' || !imageRetryBatchId)) {
            throw new Error('找不到要重试的图片，请重新打开生成结果。');
        }

        return {
            mode,
            targetNodeId,
            selectedNodeIds,
            ...(refreshTextChat ? { refreshTextChatNodeId } : {}),
            ...(runInput.agentSequential === true ? { agentSequential: true } : {}),
            ...(mode === 'selected-only' && runInput.imageBatch === true ? { imageBatch: true } : {}),
            ...(runInput.requestSource === 'agent' ? { requestSource: 'agent' } : {}),
            ...(commerceTargeted ? {
                commerceNodeId, commerceAction,
                ...(typeof commerceShotId === 'string' ? { commerceShotId } : {}),
                ...(commerceAction === 'select-candidate' ? { commerceCandidateKey } : {}),
                ...(commerceAction === 'revise-detail-page' ? { commerceDetailDirection: commerceDetailDirection.trim() } : {}),
                ...(commerceCandidateCount !== undefined ? { commerceCandidateCount } : {})
            } : {}),
            ...(visualStyleFields ? { visualStyleFields: [...new Set(visualStyleFields)] } : {}),
            ...(imageRetry ? { imageRetryNodeId, imageRetryIndex, imageRetryBatchId } : {}),
            ...(Array.isArray(runInput.includedAutoSaveNodeIds) ? {
                includedAutoSaveNodeIds: [...new Set(runInput.includedAutoSaveNodeIds.filter((id) => (
                    typeof id === 'string' && state.nodes.has(id)
                )))]
            } : {})
        };
    }

    function getImageImportOutputValue(node) {
        if (!node || node.type !== 'ImageImport') return undefined;
        if (node.importMode === 'url') {
            return node.imageUrl || node.data?.image || undefined;
        }
        const imageList = getCanonicalImageList(node);
        return imageList[0] || undefined;
    }

    async function restoreImageImportOutputValue(node) {
        const cachedValue = getImageImportOutputValue(node);
        const hasPersistedImportAsset = getImageImportMediaAssetReferences(node).length > 0;
        if (cachedValue && !hasPersistedImportAsset) return cachedValue;
        if (!node || node.type !== 'ImageImport' || node.importMode === 'url') return undefined;

        const candidateKeys = [
            ...getImageImportMediaAssetReferences(node),
            node.id ? `image-import:${node.id}` : '',
            node.id
        ].filter((key, index, list) => typeof key === 'string' && key && list.indexOf(key) === index);

        for (const key of candidateKeys) {
            const imageValue = await getImageAsset(key);
            if (!imageValue) continue;

            node.data = node.data || {};
            node.imageData = imageValue;
            node.imageDataList = [imageValue];
            node.data.image = imageValue;
            delete node.data.images;
            node.data.imageCount = 1;
            node.data.imageAssetReady = true;
            delete node.data.imageMemoryReleased;
            node.imageImportAssetKey = key;
            node.data.imageImportAssetKey = key;
            if (key.startsWith('media:')) node.data.mediaAssetKeys = [key];
            delete node.data.imageAssetKey;
            return imageValue;
        }

        return undefined;
    }

    function isFixedTextChatWithCachedResult(node) {
        if (node?.type !== 'TextChat') return false;
        const fixedToggle = documentRef.getElementById(`${node.id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        return isFixed && node.isSucceeded === true && typeof node.data?.text === 'string' && node.data.text.trim().length > 0;
    }

    function resolveExecutionPlan(runInput = null, { notify = showToast } = {}) {
        return resolveWorkflowExecutionPlan(state, normalizeRunOptions(runInput), {
            isFixedTextChatWithCachedResult, notify
        });
    }

    function topologicalSort(runInput = null) {
        const plan = resolveExecutionPlan(runInput);
        return plan ? plan.executionOrder : null;
    }

    function getCachedOutputValue(node, portName) {
        if (node?.type === 'VisualStyle' && portName === 'style' && node.enabled !== false) return normalizeVisualStyle(node.data?.visualStyle);
        if (!node || node.enabled === false) return undefined;
        if (portName === 'params' && node.type === 'CustomParams') {
            return getCustomParamsFromNode(node);
        }
        if (portName === 'image' && node.type === 'ImageImport') {
            return getImageImportOutputValue(node);
        }
        if (portName === 'image') {
            if (node.type === 'ECommerceImageSet') {
                const settings = node.data?.commerceImageSet ?? node.commerceImageSet;
                const projection = projectCommerceReferences(state, node.id);
                if (hasCommerceReferenceChange(settings, projection) || needsCommerceReferenceVerification(settings, projection)) {
                    return undefined;
                }
            }
            const imageList = getCanonicalImageList(node);
            if (imageList.length > 1) return imageList;
            if (imageList.length === 1) return imageList[0];

            if (node.type === 'ImageResize' || node.type === 'ColorReset') {
                return node.imageData || node.resizePreviewData || node.colorResetPreviewData || undefined;
            }

            if (node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageCompare') {
                return getCanonicalImage(node) || undefined;
            }
        }
        if (portName === 'video') {
            if (Array.isArray(node.data?.videos) && node.data.videos.length > 0) {
                return node.data.videos;
            }
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

            if (node.type === 'Text') {
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

        }

        if (node.data && node.data[portName] !== undefined) {
            return node.data[portName];
        }

        if (/^part_\d+$/.test(portName) && node.type === 'TextSplit') {
            if (node.data && node.data[portName] !== undefined) return node.data[portName];
            const text = node.data?.text || '';
            const delimiter = documentRef.getElementById(`${node.id}-delimiter`)?.value || '';
            const parsedOutputCount = parseInt(documentRef.getElementById(`${node.id}-output-count`)?.value ?? node.data?.outputCount ?? '0', 10);
            const outputCount = Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 0;
            const removeEmptyLinesInput = documentRef.getElementById(`${node.id}-remove-empty-lines`);
            const removeEmptyLines = removeEmptyLinesInput
                ? removeEmptyLinesInput.checked === true
                : node.data?.removeEmptyLines === true;
            const rawParts = splitTextForTextSplitNode(text, delimiter, { removeEmptyLines });
            const parts = outputCount === 0 ? rawParts : rawParts.slice(0, outputCount);
            const index = Math.max(0, parseInt(portName.replace('part_', ''), 10) - 1);
            return parts[index];
        }

        return undefined;
    }

    function getCustomParamsFromNode(node) {
        const rows = Array.from(documentRef.querySelectorAll(`#${node.id}-params-list [data-param-row]`));
        const params = {};
        const validKeys = new Set(); // 记录当前有效的参数名

        // 首先从UI输入框获取参数
        rows.forEach((row) => {
            const key = row.querySelector('.custom-param-key')?.value?.trim() || '';
            if (!key) return;
            validKeys.add(key);
            const value = row.querySelector('.custom-param-value')?.value || '';
            params[key] = coerceCustomParamValue(value);
        });

        // 然后从端口连接覆盖参数值（但只处理当前有效的参数）
        const inputs = collectCachedInputsForNode(node.id);
        Object.keys(inputs).forEach((portName) => {
            // 端口名格式为 param_{key}
            const match = portName.match(/^param_(.+)$/);
            if (!match) return;
            const key = match[1];

            // 只有当这个参数在UI中存在时，才使用端口连接的值
            if (!validKeys.has(key)) return;

            const value = inputs[portName];

            // 如果是图片数据（base64字符串），直接使用
            if (typeof value === 'string' && value.startsWith('data:image/')) {
                params[key] = value;
            } else if (typeof value === 'string') {
                params[key] = coerceCustomParamValue(value);
            } else {
                params[key] = value;
            }
        });

        node.data = node.data || {};
        node.data.params = Object.entries(params).map(([key, value]) => ({ key, value }));
        return params;
    }

    function collectCachedInputsForNode(nodeId, { requireCompleteReferences = false } = {}) {
        const inputs = {};
        const node = state.nodes.get(nodeId);
        orderInputConnections(
            node?.type,
            state.connections.filter((connection) => connection.to.nodeId === nodeId)
        )
            .forEach((connection) => {
                const fromNode = state.nodes.get(connection.from.nodeId);
                const value = getCachedOutputValue(fromNode, connection.from.port);
                if (requireCompleteReferences && fromNode?.enabled !== false
                    && /^(?:referenceImages|image(?:_\d+)?)$/.test(connection.to.port)) {
                    const images = normalizeImageList(value);
                    const output = projectImageOutput(fromNode, images);
                    if (!images.length) throw new Error('已连接的参考图输入未读取到图片数据，请先生成或导入原图。');
                    if (output.missingPositions.length || output.count > images.length) {
                        throw new Error('已连接参考来源的原图存在缺失，读取批次不完整；请恢复原图后重试。');
                    }
                }
                if (value === undefined) return;
                if (isMultiConnectionInput(node?.type, connection.to.port)) {
                    inputs[connection.to.port] = appendReferenceImages(
                        inputs[connection.to.port],
                        value,
                        // Image generation validates the complete batch against its active protocol below.
                        node?.type === 'ImageGenerate' ? Infinity : MAX_REFERENCE_IMAGE_COUNT
                    );
                } else {
                    inputs[connection.to.port] = value;
                }
            });
        return inputs;
    }

    function resolveRequestNodeConfig(node, taskType) {
        const configId = node.type === 'ImageGenerate' ? readImageGenerationSettings(node, documentRef).apiConfigId : documentRef.getElementById(`${node.id}-apiconfig`)?.value || '';
        const modelCfg = state.models.find((model) => model.id === configId);
        if (!modelCfg) throw new Error('未找到选定的模型配置');
        const selectedProviderId = node.type === 'ImageGenerate' ? readImageGenerationSettings(node, documentRef).providerId : documentRef.getElementById(`${node.id}-provider`)?.value || node.providerId || '';
        const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
        const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
        if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
        const protocol = getEffectiveProtocol(modelCfg, apiCfg);
        return {
            modelCfg,
            apiCfg,
            protocol,
            url: resolveProviderUrl(apiCfg, modelCfg, taskType, { action: 'create', inputs: collectCachedInputsForNode(node.id) })
        };
    }

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
            modelId: modelCfg?.id || '',
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

    function getProviderRequestFailureStatus(error) {
        const status = Number(error?.serverResponse?.status ?? error?.details?.status);
        return Number.isFinite(status) ? status : undefined;
    }

    async function runTrackedProviderRequest(node, apiCfg, modelCfg, url, requestFn, { onOutcome, ...options } = {}) {
        const recordOutcome = createProviderRequestOutcomeRecorder(node, apiCfg, modelCfg, url, options);
        let result;
        try {
            result = await requestFn();
        } catch (error) {
            recordOutcome(false, { status: getProviderRequestFailureStatus(error) });
            onOutcome?.(false, error);
            throw error;
        }
        recordOutcome(true);
        onOutcome?.(true);
        return result;
    }

    function startCommerceRequestLog(node, request, { action, shot, signal, candidateIndex, candidateCount }) {
        const { model } = request;
        const label = { analyze: '分析产品', plan: '生成方案', 'replan-shot': '重做方案', 'revise-detail-page': '调整详情页版式',
            generate: '生成图片', fill: '补齐图片', retry: '重试图片' }[action];
        const candidate = candidateCount > 1 ? ` · 候选 ${candidateIndex}/${candidateCount}` : '';
        const title = `电商套图 · ${label}${shot ? `「${shot.label}」` : ''}${candidate} · ${model.name || model.modelId}`;
        return startWorkflowImageRequestLog(node, request, { title, operation: action, shotId: shot?.id, signal });
    }

    function startWorkflowImageRequestLog(node, request, { title, operation, shotId, signal }) {
        signal?.throwIfAborted();
        const { provider, protocol, requestBody } = request;
        const url = sanitizeRequestUrl(request.url);
        const finish = logRequestToPanel?.(title, url, requestBody, {
            requestStatus: 'pending',
            operation,
            nodeId: node.id,
            nodeType: node.type,
            ...(shotId ? { shotId } : {}),
            providerType: protocol
        });
        if (typeof finish !== 'function') return;
        return (success, error) => {
            if (success) {
                finish('success');
            } else if (isAbortLikeError(error, signal)) {
                finish('canceled');
            } else {
                const message = String(error?.message || error || '请求失败');
                finish('failed', {
                    status: getProviderRequestFailureStatus(error),
                    error: provider.apikey ? message.replaceAll(provider.apikey, '[REDACTED]') : message
                });
            }
        };
    }

    function assertImageInputCompatibility(node, inputs, settings) {
        const reason = validateUniversalImageInputs({ state, node: { ...node, apiConfigId: settings.apiConfigId }, inputs });
        if (reason) throw new Error(reason);
    }

    function resolveRequestMentions(node, inputs, prompts, { signal, videoPorts } = {}) {
        const hasSnapshot = source => Boolean(signal && sceneReferenceImages.has(source.id));
        return resolvePromptImageMentions({ node, inputs, prompts, videoPorts, signal, workflowId: getActiveWorkflowId(),
            getUpstream: () => referenceImageCatalog?.getUpstream?.(node.id, { state }) || [],
            readImage: source => hasSnapshot(source) ? sceneReferenceImages.get(source.id)
                : referenceImageCatalog?.readImage(source, { state }) });
    }

    function withRequestMentions(node, inputs, prompts, build, options) {
        const resolved = resolveRequestMentions(node, inputs, prompts, options);
        return resolved instanceof Promise ? resolved.then(build) : build(resolved);
    }

    function buildImageGenerateRequestPreview(node, inputs) {
        const prompt = buildImageGeneratePrompt(node, inputs);
        return withRequestMentions(node, inputs, [prompt], ({ inputs, prompts }) =>
            renderImageGenerateRequestPreview(node, inputs, prompts[0]));
    }

    function renderImageGenerateRequestPreview(node, inputs, prompt) {
        const { id } = node;
        const settings = readImageGenerationSettings(node, documentRef);
        const { modelCfg, apiCfg, protocol } = resolveRequestNodeConfig(node, 'image');
        assertImageInputCompatibility(node, inputs, settings);
        const { aspect, resolution } = readImageGenerateRequestSize(settings, protocol, modelCfg.modelId);
        const quality = settings.quality;
        const moderation = settings.moderation;
        const background = settings.background;
        const mask = getImageGenerateMask(inputs);
        const searchEnabled = settings.search;
        const protocolParams = getImageGenerateProtocolParams(node);
        const isGoogle = protocol === 'google';
        const isTtapi = protocol === 'ttapi';
        const isTtapiOpenAi = protocol === 'ttapi-openai';
        const isNewApiAsyncImage = protocol === 'newapi-image-async';
        const url = resolveProviderUrl(apiCfg, modelCfg, 'image', {
            action: isNewApiAsyncImage ? 'create' : undefined,
            inputs
        });
        const isOpenAiImageEdit = protocol === 'openai' && /\/images\/edits\/?(?:$|[?#])/i.test(url);
        const requestBody = isNewApiAsyncImage
            ? buildNewApiAsyncImageRequest({ modelCfg, prompt, aspect, resolution, inputs })
            : (isTtapi
                ? buildTtapiImageRequest({ modelCfg, prompt, inputs, aspect, resolution, searchEnabled, protocolParams })
                : (isTtapiOpenAi
                    ? buildTtapiOpenAiImageRequest({ modelCfg, prompt, resolution, quality, moderation, background, inputs, protocolParams })
                    : (isGoogle
                        ? buildGoogleImageRequest({ modelId: modelCfg.modelId, prompt, inputs, aspect, resolution, searchEnabled })
                        : buildOpenAiImageRequest({
                    modelCfg,
                    prompt,
                    resolution,
                    quality,
                    moderation,
                    background,
                    mask: isOpenAiImageEdit ? mask : null,
                    inputs,
                    protocolParams,
                    protocol,
                    url,
                    edit: isOpenAiImageEdit
                }))));
        applyThinking(requestBody, { model: modelCfg, provider: apiCfg, task: 'image', protocol }, node.data?.thinking);
        return {
            nodeId: id,
            nodeType: node.type,
            model: modelCfg.name || modelCfg.modelId,
            provider: apiCfg.name || apiCfg.id || '',
            protocol,
            method: 'POST',
            url,
            contentType: isOpenAiImageEdit ? 'multipart/form-data' : 'application/json',
            note: isOpenAiImageEdit ? '该节点实际发送时会把参考图转换为 multipart/form-data 文件字段。' : '',
            requestBody
        };
    }

    function readImageGenerateRequestSize(settings, protocol, modelId) {
        return resolveImageRequestSize({ protocol, modelId, aspect: settings.aspect, resolution: settings.resolution,
            customWidth: settings.customWidth, customHeight: settings.customHeight });
    }

    function buildVideoGenerateRequestPreview(node, inputs) {
        const { id } = node;
        const { modelCfg, apiCfg, protocol } = resolveRequestNodeConfig(node, 'video');
        const userPrompt = (getPrimaryTextInput(inputs.prompt)
            || documentRef.querySelector?.(`#${id} [data-protocol-prompt="true"]`)?.value
            || documentRef.getElementById(`${id}-param-prompt`)?.value
            || documentRef.getElementById(`${id}-prompt`)?.value
            || '').trim();
        const systemPrompt = (documentRef.getElementById(`${id}-param-systemPrompt`)?.value || node?.data?.protocolParams?.systemPrompt || '').trim();
        const declaredProtocol = getProtocolSnapshot(protocol);
        const videoPorts = resolveGenerationInputProjection({ protocol: declaredProtocol, modelId: modelCfg.modelId, taskType: 'video' }).ports;
        const prompt = appendReferenceDescriptions(userPrompt, state, id);
        return withRequestMentions(node, inputs, [prompt, systemPrompt], ({ inputs, prompts }) => {
            const [user, system] = prompts;
            return renderVideoGenerateRequestPreview(node, inputs, system ? system + '\n' + user : user, { modelCfg, apiCfg, protocol, declaredProtocol });
        }, { videoPorts });
    }

    function renderVideoGenerateRequestPreview(node, inputs, prompt, { modelCfg, apiCfg, protocol, declaredProtocol }) {
        const { id } = node;
        const protocolParams = node.data?.protocolParams || {};
        const declaredPlan = Object.keys(declaredProtocol?.variants || {}).length > 0
            ? compileVideoProtocol({
                protocol: declaredProtocol,
                endpoint: apiCfg.endpoint,
                modelId: modelCfg.modelId,
                parameters: { ...protocolParams, prompt },
                inputs,
                apiKey: apiCfg.apikey
            })
            : null;
        if (declaredPlan) {
            const safePlan = redactProtocolPreview({
                url: declaredPlan.create.url,
                headers: declaredPlan.create.headers,
                body: declaredPlan.create.body,
                multipartFields: declaredPlan.create.encoding === 'multipart' ? declaredPlan.create.fields : undefined
            }, declaredPlan.authentication);
            return {
                nodeId: id,
                nodeType: node.type,
                model: modelCfg.name || modelCfg.modelId,
                provider: apiCfg.name || apiCfg.id || '',
                protocol,
                method: declaredPlan.create.method,
                url: safePlan.url,
                headers: safePlan.headers,
                contentType: declaredPlan.create.encoding === 'multipart' ? 'multipart/form-data' : 'application/json',
                requestBody: safePlan.body,
                multipartFields: declaredPlan.create.encoding === 'multipart' ? safePlan.multipartFields : undefined
            };
        }
        const aspect = protocolParams.size || protocolParams.aspect_ratio || protocolParams.aspect
            || documentRef.getElementById(`${id}-aspect`)?.value || '16:9';
        const useVideoSizeParam = protocolParams.size !== undefined || documentRef.getElementById(`${id}-use-size-param`)?.checked === true;
        const useSizeParam = (protocol === 'veo-unified' || protocol === 'veo-openai') && useVideoSizeParam;
        const videoDuration = protocolParams.duration ?? '';
        const videoLoop = protocolParams.loop === true;
        const requestBody = protocol === 'veo-openai'
            ? buildOpenAiVideoRequest({ modelCfg, prompt, aspectRatio: aspect, useSizeParam, duration: videoDuration, loop: videoLoop, inputs })
            : (protocol === 'doubao-video'
                ? buildDoubaoVideoRequest({
                    modelCfg,
                    prompt,
                    aspectRatio: aspect,
                    resolution: protocolParams.resolution ?? documentRef.getElementById(`${id}-doubao-resolution`)?.value ?? '',
                    duration: protocolParams.duration ?? documentRef.getElementById(`${id}-doubao-duration`)?.value ?? '',
                    cameraFixed: protocolParams.camera_fixed ?? (documentRef.getElementById(`${id}-doubao-camera-fixed`)?.checked === true),
                    generateAudio: protocolParams.generate_audio ?? (documentRef.getElementById(`${id}-doubao-generate-audio`)?.checked === true),
                    watermark: protocolParams.watermark ?? (documentRef.getElementById(`${id}-doubao-watermark`)?.checked === true),
                    seed: protocolParams.seed ?? documentRef.getElementById(`${id}-doubao-seed`)?.value ?? '',
                    inputs
                })
                : buildUnifiedVideoRequest({
                    modelCfg,
                    prompt,
                    aspectRatio: aspect,
                    useSizeParam,
                    duration: videoDuration,
                    loop: videoLoop,
                    enhancePrompt: protocolParams.enhance_prompt ?? (documentRef.getElementById(`${id}-enhance-prompt`)?.checked === true),
                    enableUpsample: protocolParams.enable_upsample ?? (documentRef.getElementById(`${id}-enable-upsample`)?.checked === true),
                    inputs
                }));
        return {
            nodeId: id,
            nodeType: node.type,
            model: modelCfg.name || modelCfg.modelId,
            provider: apiCfg.name || apiCfg.id || '',
            protocol,
            method: 'POST',
            url: resolveProviderUrl(apiCfg, modelCfg, 'video', { action: 'create' }),
            contentType: 'application/json',
            requestBody
        };
    }

    function readTextChatPrompts(node, inputs) {
        const { id } = node;
        const sysprompt = documentRef.getElementById(`${id}-sysprompt`)?.value || '';
        const prompt = appendReferenceDescriptions(getPrimaryTextInput(inputs.prompt) || documentRef.getElementById(`${id}-prompt`)?.value || '', state, id);
        return [prompt, sysprompt];
    }

    function createTextChatRequestPlan(node, inputs, [prompt, sysprompt]) {
        const { id } = node;
        const { modelCfg, apiCfg, protocol } = resolveRequestNodeConfig(node, 'chat');
        return createChatRequestPlan({
            provider: apiCfg,
            model: modelCfg,
            protocol,
            systemPrompt: sysprompt,
            messages: [{ role: 'user', content: prompt }],
            media: getOpenAiImageContents(inputs).map((item) => ({ type: 'image', url: item.image_url.url })),
            searchEnabled: documentRef.getElementById(`${id}-search`)?.checked === true,
            thinking: node.data?.thinking,
            customParams: inputs.params
        });
    }

    function buildTextChatRequestPreview(node, inputs) {
        return withRequestMentions(node, inputs, readTextChatPrompts(node, inputs), ({ inputs, prompts }) => ({
            nodeId: node.id,
            nodeType: node.type,
            ...createTextChatRequestPlan(node, inputs, prompts).preview
        }));
    }

    function buildNodeRequestPreview(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) throw new Error('节点不存在');
        const inputs = collectCachedInputsForNode(nodeId, { requireCompleteReferences: node.type === 'ImageGenerate' });
        if (node.type === 'ImageGenerate') return buildImageGenerateRequestPreview(node, inputs);
        if (node.type === 'VideoGenerate') return buildVideoGenerateRequestPreview(node, inputs);
        if (node.type === 'TextChat') return buildTextChatRequestPreview(node, inputs);
        throw new Error('该节点没有可预览的 API 请求体');
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

    function hasRemoteImageInput(inputs = {}) {
        return Object.values(inputs).some((value) => hasRemoteImageValue(value));
    }

    async function getReferenceImageBlob(value, signal) {
        if (isInlineImageData(value)) return dataURLtoBlob(value);
        if (isRemoteImageUrl(value)) return downloadGeneratedImage(value, signal);
        throw new Error('OpenAI 兼容图片编辑只支持 data URL 或 HTTP(S) 参考图');
    }

    function getImageGenerateMask(inputs = {}) {
        const data = getPrimaryImageInput(inputs.mask);
        if (!data) return null;
        return {
            data,
            name: 'mask.png',
            size: 0,
            type: ''
        };
    }

    function getImageGenerateProtocolParams(node) {
        return readImageGenerationSettings(node, documentRef).protocolParams;
    }

    function buildImageGeneratePrompt(node, inputs = {}) {
        const id = node?.id || '';
        const settings = readImageGenerationSettings(node, documentRef);
        const userPrompt = (getPrimaryTextInput(inputs.prompt)
            || settings.protocolParams.prompt
            || settings.prompt
            || '').trim();
        const cameraPrompt = getPrimaryTextInput(inputs.camera_prompt).trim();
        const systemPrompt = (settings.protocolParams.systemPrompt || '').trim();

        const promptSections = [];
        if (userPrompt) {
            promptSections.push(userPrompt);
        }
        if (cameraPrompt) {
            promptSections.push(cameraPrompt);
        }
        const stylePrompt = buildVisualStylePrompt(resolveVisualStyle(state, id, inputs), { lettering: true });
        if (stylePrompt) promptSections.push(stylePrompt);
        const combinedPrompt = appendReferenceDescriptions(promptSections.join('\n\n'), state, id);

        if (systemPrompt) {
            return systemPrompt + '\n' + combinedPrompt;
        }
        return combinedPrompt;
    }

    function getOpenAiImageRequestLogBody(requestBody, inputs, modelId) {
        const referenceImages = getOpenAiReferenceImages(inputs);
        const guideField = requestBody.markup?.data ? 'markup' : requestBody.mask?.data ? 'mask' : '';
        const guide = requestBody[guideField];
        if (referenceImages.length === 0 && !guideField) return requestBody;
        const guideSize = guideField === 'mask' ? `, ${guide.size || 0} bytes` : '';
        return {
            ...getOpenAiImageEditFields(requestBody, modelId),
            image: `[${referenceImages.length} reference image file(s)]`,
            ...(guideField ? { [guideField]: `[${guideField} file: ${guide.name || guideField + '.png'}${guideSize}]` } : {})
        };
    }

    const asyncMediaExecution = createAsyncMediaExecutionApi({
        state,
        documentRef,
        windowRef,
        fetchRef,
        addLog,
        recordNodeRequest,
        getProxyHeaders,
        classifyProviderError,
        logRequestToPanel,
        formatProxyErrorMessage,
        parseJsonResponseOrThrow,
        recoverImageResultFromFailedResponse,
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
        saveVideoGenerationHistoryEntry,
        persistVideoGenerationResults: (node, videoBlobs) => persistVideoResultForNode({
            node,
            videoBlobs,
            workflowId: getActiveWorkflowId(),
            saveWorkflowNodeMediaAssets,
            rememberWorkflowMediaOperation
        }),
        getNodeGenerationDurationSeconds,
        getImageHistorySidebarActive,
        renderHistoryList,
        refreshDependentImageResizePreviews,
        connectionProjection,
        scheduleSave,
        onNodeResultUpdated,
        requestNodeFit
    });

    async function readMergeInputImages(node, inputs) {
        const entries = Object.entries(inputs)
            .filter(([key]) => /^image_\d+$/.test(key))
            .sort(([a], [b]) => parseInt(a.replace('image_', ''), 10) - parseInt(b.replace('image_', ''), 10));
        for (const [port, value] of entries) {
            const edge = state.connections.find(connection => connection.to?.nodeId === node.id && connection.to?.port === port);
            const source = state.nodes.get(edge?.from?.nodeId);
            if ((Array.isArray(value) && value.some(item => !item)) || source?.data?.mediaIntegrity?.missingItems?.length) {
                await syncImageMergeNode(node.id, []);
                const error = new Error('来源批次存在缺失原图，完整位置已保留，请恢复原图后重试');
                error.inputPort = port;
                throw error;
            }
        }
        return entries.flatMap(([, value]) => normalizeImageList(value));
    }

    async function executeCommerceImageSet(node, inputs, parentSignal, {
        commerceAction = 'generate', commerceShotId, commerceCandidateKey, commerceCandidateCount, commerceConfirmOnExecution = false,
        commerceDetailDirection
    } = {}) {
        parentSignal?.throwIfAborted();
        if (!commerceActions.has(commerceAction)) throw new Error('无效的电商套图操作。');
        const settings = normalizeCommerceImageSetState(node.data?.commerceImageSet);
        const target = settings.plan?.shots.find(shot => shot.id === commerceShotId);
        const visualStyle = resolveCommerceImageSetStyle(settings, resolveVisualStyle(state, node.id, inputs));
        settings.visualStyle = visualStyle;
        if (!['plan', 'analyze', 'select-candidate'].includes(commerceAction) && settings.plan
            && visualStyleKey(settings.plan.visualStyle) !== visualStyleKey(visualStyle)) {
            throw new Error('画面风格已更新，请重新规划并确认；已有成图和定稿保留。');
        }
        const replanningShot = commerceAction === 'replan-shot';
        const appendingCandidates = commerceAction === 'generate-candidates';
        const retryingShot = commerceAction === 'retry' || appendingCandidates;
        const selectingCandidate = commerceAction === 'select-candidate';
        const revisingDetailPage = commerceAction === 'revise-detail-page';
        const filling = commerceAction === 'fill';
        const shotTask = replanningShot || retryingShot || selectingCandidate;
        const planning = replanningShot || revisingDetailPage || ['analyze', 'plan'].includes(commerceAction);
        const referenceProjection = projectCommerceReferences(state, node.id);
        const styleProjection = projectCommerceStyleReferences(state, node.id);
        if (!['analyze', 'plan', 'select-candidate'].includes(commerceAction) && hasCommerceStyleReferenceChange(settings, styleProjection)) {
            throw new Error('风格参考图已更新，请重新规划并确认。');
        }
        const referenceRevision = getCommerceReferenceRevision(referenceProjection);
        if (!['analyze', 'plan'].includes(commerceAction) && hasCommerceReferenceChange(settings, referenceProjection)) {
            throw new Error(COMMERCE_REFERENCE_CHANGED_MESSAGE);
        }
        if (shotTask && target?.source !== 'generate') throw new Error('请选择一个需要生图的图位。');
        if (commerceShotId && !revisingDetailPage && isCommerceShotFinalized(settings, commerceShotId)) throw new Error('图位已定稿，请先解锁。');
        if (selectingCandidate && typeof commerceCandidateKey !== 'string') throw new Error('请选择一个候选图片。');
        if (!planning && commerceShotId && !target) throw new Error('找不到所选图位。');
        let sceneToConfirm;
        if (!planning && !selectingCandidate && target?.customScene && !target.sceneConfirmed) {
            sceneToConfirm = JSON.stringify(target);
            if (!commerceConfirmOnExecution || commerceAction !== 'retry' || !confirmCommerceSceneShot(settings, commerceShotId)) {
                throw new Error('请先确认这张场景图的方案。');
            }
        }
        const planToConfirm = commerceConfirmOnExecution && !commerceShotId && ['generate', 'fill'].includes(commerceAction)
            && settings.plan && !settings.plan.confirmed ? JSON.stringify(settings.plan) : '';

        const shots = filling ? getUnfinishedCommerceImageSetShots(settings)
            : planning || selectingCandidate ? []
                : getGeneratableCommerceImageSetShots(settings).filter(shot => !commerceShotId || shot.id === commerceShotId);
        if (filling && settings.plan?.confirmed && !shots.length) throw new Error('所有图位已完成。');
        const claimedIds = shotTask ? [commerceShotId] : shots.map(shot => shot.id);
        const handlers = node.commerceShotCancelHandlers ??= new Map();
        if (claimedIds.some(id => handlers.has(id))) throw new Error('所选图位有任务正在运行。');
        if (!shotTask && (commerceBatches.has(node) || handlers.size)) throw new Error('电商套图有任务正在运行。');

        const controller = shotTask ? new AbortController() : null;
        const signal = controller ? AbortSignal.any([controller.signal, parentSignal].filter(Boolean)) : parentSignal;
        const batch = !planning && !shotTask
            ? { redo: commerceAction === 'generate', replacedShotIds: new Set(), previews: new Map(),
                controllers: new Map(shots.map(shot => [shot.id, new AbortController()])) }
            : null;
        const previews = batch?.previews || new Map();
        const candidateCount = (appendingCandidates ? commerceCandidateCount : undefined) ?? settings.candidateCount ?? 1;
        const attempts = new Map();
        function reportProgress(shotId, preview) {
            if (shotId) {
                previews.set(shotId, preview);
                (node.commerceShotPreviews ??= {})[shotId] = preview;
            }
            if (batch || !commerceBatches.has(node)) {
                node.apiGenerationProgress = {
                    completed: [...previews.values()].filter(row => row.status === 'completed').length,
                    total: shots.length
                };
            }
            onNodeResultUpdated(node.id, { progressOnly: true });
        }
        const ownHandlers = new Map();
        if (shotTask) {
            (node.commerceShotTasks ??= {})[commerceShotId] = selectingCandidate ? 'selecting' : replanningShot ? 'planning' : 'running';
            ownHandlers.set(commerceShotId, () => {
                if (controller.signal.aborted) return false;
                controller.abort();
                return true;
            });
        } else if (batch) {
            commerceBatches.set(node, batch);
            for (const [id, shotController] of batch.controllers) {
                if (node.commerceShotTasks) delete node.commerceShotTasks[id];
                const preview = { status: 'pending' };
                previews.set(id, preview);
                (node.commerceShotPreviews ??= {})[id] = preview;
                ownHandlers.set(id, () => {
                    if (shotController.signal.aborted) return false;
                    shotController.abort();
                    if (previews.get(id)?.status !== 'running') {
                        handlers.delete(id);
                        reportProgress(id, { status: 'canceled' });
                    }
                    return true;
                });
            }
        }
        for (const [id, cancel] of ownHandlers) handlers.set(id, cancel);
        if (batch) reportProgress();
        else if (shotTask) onNodeResultUpdated(node.id, { progressOnly: true });

        try {
            const allFinalized = commerceAction === 'generate' && !commerceShotId && !shots.length
                && getRunnableCommerceImageSetShots(settings).length > 0;
            const sourceImages = normalizeImageList(inputs.referenceImages);
            if (selectingCandidate || allFinalized) {
                const referenceContentKey = settings.plan?.referenceContentKey;
                const requiresVerification = needsCommerceReferenceVerification(settings, referenceProjection);
                if (requiresVerification) {
                    const verification = await verifyCommerceReferenceContent({
                        settings, projection: referenceProjection, readAsset: getImageAsset
                    });
                    if (verification.status !== 'matched') throw new Error(COMMERCE_REFERENCE_CHANGED_MESSAGE);
                }
                if (referenceContentKey && sourceImages.length && sourceImages.every(isInlineImageData)
                    && referenceContentKey !== await commerceImageSetReferenceContentKey(sourceImages)) {
                    throw new Error(COMMERCE_REFERENCE_CHANGED_MESSAGE);
                }
                return await publishCommerceShots(node, { attempts, batch, signal, commerceShotId, workflowId: getActiveWorkflowId(),
                    commerceCandidateKey: selectingCandidate ? commerceCandidateKey : undefined,
                    approvedReferences: referenceProjection.groups.some(group => group.enabled) ? referenceProjection : null });
            }
            if (!sourceImages.length || sourceImages.length > 5) throw new Error('请连接 1 至 5 张商品参考图。');
            const readCommerceImage = async (image, requestSignal) => {
                if (isInlineImageData(image)) return image;
                if (isRemoteImageUrl(image)) return blobToDataUrl(await downloadGeneratedImage(image, requestSignal));
                throw new Error('无法读取商品参考图，请重新连接原图。');
            };
            const references = await Promise.all(sourceImages.map(image => readCommerceImage(image, signal)));
            const styleInputs = normalizeImageList(inputs.styleReferenceImages);
            if (commerceAction !== 'analyze' && (styleProjection.groups.some(group => group.enabled && (group.missing || group.running || !group.count))
                || styleProjection.slots.some(slot => slot.missing) || styleInputs.length !== styleProjection.slots.length)) {
                throw new Error('风格参考图来源尚未就绪，请检查上游的原图后重试。');
            }
            const connectedStyleSlots = styleProjection.slots.map((slot, index) => {
                let original;
                return { ...slot, readImage: async requestSignal => {
                    original ??= await readCommerceImage(styleInputs[index], requestSignal);
                    return original;
                } };
            });
            signal?.throwIfAborted();
            if (planning) {
                const operation = revisingDetailPage ? reviseCommerceDetailPage
                    : commerceAction === 'analyze' ? analyzeCommerceImageSetProduct : createCommerceImageSetPlan;
                const updated = await operation({ settings, references, referenceRevision, models: state.models,
                    readReferenceAsset: getImageAsset, connectedStyleSlots,
                    providers: state.providers, fetchRef, getProxyHeaders, signal,
                    shotId: replanningShot || revisingDetailPage ? commerceShotId : undefined,
                    description: commerceDetailDirection,
                    runRequest: (request, execute, shot) => {
                        const onOutcome = startCommerceRequestLog(node, request, { action: commerceAction, shot, signal });
                        return runTrackedProviderRequest(node, request.provider, request.model, sanitizeRequestUrl(request.url), execute, { onOutcome });
                    } });
                signal?.throwIfAborted();
                const current = normalizeCommerceImageSetState(node.data?.commerceImageSet);
                current.visualStyle = resolveCommerceImageSetStyle(current, resolveVisualStyle(state, node.id, inputs));
                const styleInputsChanged = commerceAction !== 'analyze' && commerceConnectedStyleRevision(settings, styleProjection)
                    !== commerceConnectedStyleRevision(current, projectCommerceStyleReferences(state, node.id));
                const scope = revisingDetailPage ? undefined : commerceShotId;
                if (state.nodes.get(node.id) !== node || styleInputsChanged ||
                    commerceImageSetPlanningSettingsKey(settings, scope) !== commerceImageSetPlanningSettingsKey(current, scope)) {
                    throw new Error('商品设置已改变，请根据当前设置重新执行。');
                }
                assertCommercePlanningCurrent(node.id, commerceShotId, { commerceAction });
                if (replanningShot) {
                    const replacement = updated.plan.shots.find(shot => shot.id === commerceShotId);
                    node.data.commerceImageSet = { ...current, plan: { ...updated.plan, confirmed: target.customScene ? current.plan.confirmed : false,
                        shots: current.plan.shots.map(shot => shot.id === commerceShotId ? replacement : shot) } };
                } else {
                    node.data.commerceImageSet = updated;
                    if (commerceAction === 'plan') syncReplannedCommerceOutput(node, updated);
                }
                onNodeResultUpdated(node.id);
                return;
            }

            const { plan } = settings;
            if (plan?.stale) throw new Error('商品资料、参考图或生成设置已改变，请重新规划并确认。');
            if (!plan || (!plan.confirmed && !retryingShot && !planToConfirm)) throw new Error('请先规划电商套图并确认方案。');
            if (plan.sourceKey !== await commerceImageSetSourceKey({ settings, references })) {
                throw new Error('商品资料、参考图或生成设置已改变，请重新规划并确认。');
            }
            signal?.throwIfAborted();
            const workflowId = getActiveWorkflowId();
            if (!workflowId) throw new Error('套图结果需要保存到当前工作流。');
            assertCommercePlanningCurrent(node.id, commerceShotId);

            const generationInputs = { referenceImages: references };
            const generatedShots = shots.filter(shot => shot.source === 'generate');
            const missingPrompt = generatedShots.find(shot => !shot.prompt);
            if (missingPrompt) throw new Error(`「${missingPrompt.label}」缺少生图提示词，请补充后重试。`);
            let imageSettings;
            if (generatedShots.length) {
                imageSettings = resolveCommerceImageGenerationSettings({ state, settings, generatedShots });
                assertImageInputCompatibility(node, generationInputs, imageSettings);
            }

            if (retryingShot || filling) {
                await readRetainedCommerceImages(settings, settings.results.filter(row => row.shotId !== commerceShotId), signal);
            } else if (settings.results.some(row => row.finalized)) {
                await readRetainedCommerceImages(settings, settings.results.filter(row => row.finalized), signal);
            }
            let firstError;
            for (const shot of shots) {
                signal?.throwIfAborted();
                const shotController = batch?.controllers.get(shot.id);
                const shotSignal = shotController ? AbortSignal.any([shotController.signal, signal].filter(Boolean)) : signal;
                const images = [];
                const total = shot.source === 'generate' ? candidateCount : 1;
                const planKey = commerceShotPlanKey(shot);
                const candidateProgress = () => total > 1 ? { candidateProgress: { completed: images.length, total } } : {};
                const reportRunning = () => reportProgress(shot.id, { status: 'running', ...candidateProgress() });
                try {
                    shotSignal?.throwIfAborted();
                    reportRunning();
                    if (shot.source === 'reference') {
                        const image = references[0];
                        await saveImageGenerationHistoryEntry({ nodeId: node.id, image, prompt: shot.label,
                            model: '商品原图', generationDurationSeconds: getNodeGenerationDurationSeconds(node) });
                        images.push(image);
                    } else {
                        const designReferences = await readCommerceShotReferences(settings, shot.id, getImageAsset, shotSignal, connectedStyleSlots);
                        const resolved = await resolveRequestMentions(node, { referenceImages: sourceImages }, [shot.prompt], { signal: shotSignal });
                        const shotPrompt = [buildCommerceImageSetImagePrompt({ shot: { ...shot, prompt: resolved.prompts[0] }, plan, productInfo: settings.productInfo }),
                            buildCommerceShotReferenceInstructions(references.length, designReferences.length)].filter(Boolean).join('\n');
                        const extraImages = resolved.inputs.referenceImages.slice(sourceImages.length);
                        if (references.length + designReferences.length + extraImages.length > 5) throw new Error('每个图位最多使用 5 张参考图，请减少设计参考、提示词引用或上游输入。');
                        const shotInputs = extraImages.length || designReferences.length
                            ? { referenceImages: [...references, ...designReferences, ...await Promise.all(extraImages.map(image => readCommerceImage(image, shotSignal)))] }
                            : generationInputs;
                        assertImageInputCompatibility(node, shotInputs, imageSettings);
                        // Keep 4:5 exact at roughly 1K, using dimensions aligned to 16 pixels.
                        const size = imageSettings.resolution === '1K' && shot.aspect === '4:5'
                            ? { resolution: 'custom', customWidth: '832', customHeight: '1040' } : { aspect: shot.aspect };
                        let candidateError;
                        for (let index = 1; index <= total; index++) {
                            shotSignal?.throwIfAborted();
                            try {
                                const { image } = await nodeHandlers.ImageGenerate(node, shotInputs, shotSignal, {
                                    preparedImageRequest: {
                                        visualStyleSnapshot: shot.visualStyleSnapshot ?? visualStyle,
                                        prompt: shotPrompt,
                                        settings: { ...imageSettings, ...size },
                                        startRequestLog: request => startCommerceRequestLog(node, request, {
                                            action: commerceAction, shot, signal: shotSignal, candidateIndex: index, candidateCount: total
                                        })
                                    }
                                });
                                if (!image) throw new Error('供应商未返回图片，请重试。');
                                if (!images.includes(image)) images.push(image);
                            } catch (error) {
                                if (isAbortLikeError(error, shotSignal)) throw error;
                                candidateError ||= error;
                            }
                            if (total > 1 && index < total) reportRunning();
                        }
                        if (!images.length) throw candidateError;
                    }
                    shotSignal?.throwIfAborted();
                    const result = { status: 'completed', image: images[0], ...(planKey ? { planKey } : {}),
                        ...(shot.detailAssetKind ? { detailAssetKind: shot.detailAssetKind } : {}), ...candidateProgress() };
                    attempts.set(shot.id, { ...result, images, shot });
                    reportProgress(shot.id, result);
                } catch (error) {
                    if (total > 1 && images.length && shotSignal?.aborted && !parentSignal?.aborted) {
                        attempts.set(shot.id, { status: 'canceled', images, shot, planKey, ...candidateProgress() });
                    }
                    if (isAbortLikeError(error, signal)) {
                        if (!batch || signal?.aborted || !shotController.signal.aborted) throw error;
                    }
                    if (shotController?.signal.aborted) {
                        const result = { status: 'canceled' };
                        if (!attempts.has(shot.id)) attempts.set(shot.id, result);
                        if (handlers.get(shot.id) === ownHandlers.get(shot.id)) reportProgress(shot.id, result);
                    } else {
                        if (retryingShot && settings.results.some(row => row.shotId === shot.id && row.status === 'completed')) throw error;
                        firstError ||= error;
                        const result = { status: 'failed', error: String(error?.message || '生成失败').slice(0, 300) };
                        attempts.set(shot.id, result);
                        reportProgress(shot.id, result);
                    }
                } finally {
                    if (batch && handlers.get(shot.id) === ownHandlers.get(shot.id)) handlers.delete(shot.id);
                }
            }

            return await publishCommerceShots(node, { attempts, batch, firstError, workflowId, signal, commerceShotId,
                appendCandidates: appendingCandidates, planToConfirm, sceneToConfirm });
        } catch (error) {
            if (shotTask && controller.signal.aborted) {
                if (retryingShot && !parentSignal?.aborted) {
                    const partial = attempts.get(commerceShotId);
                    await publishCommerceShots(node, {
                        attempts: new Map([[commerceShotId, { ...partial, status: 'canceled' }]]),
                        workflowId: getActiveWorkflowId(), commerceShotId, appendCandidates: appendingCandidates
                    });
                }
                // Use a typed abort even when the provider mapped it to a generic network failure.
                throw controller.signal.reason;
            }
            signal?.throwIfAborted();
            throw error;
        } finally {
            for (const [id, cancel] of ownHandlers) if (handlers.get(id) === cancel) handlers.delete(id);
            if (batch) commerceBatches.delete(node);
            if (shotTask && controller.signal.aborted) node.commerceShotTasks[commerceShotId] = 'canceled';
            else if (shotTask) delete node.commerceShotTasks[commerceShotId];
            for (const [id, preview] of previews) {
                if (node.commerceShotPreviews?.[id] !== preview) continue;
                const activeBatch = commerceBatches.get(node);
                const batchPreview = activeBatch?.previews.get(id);
                if (batchPreview && !activeBatch.replacedShotIds.has(id)) node.commerceShotPreviews[id] = batchPreview;
                else delete node.commerceShotPreviews[id];
            }
            if (node.commerceShotPreviews && !Object.keys(node.commerceShotPreviews).length) delete node.commerceShotPreviews;
            if (!commerceBatches.has(node) && !node.commerceShotPreviews) delete node.apiGenerationProgress;
            if (ownHandlers.size) onNodeResultUpdated(node.id, { progressOnly: true });
        }
    }

    async function removeCommerceScene(node, shotId, canEdit) {
        if (!canEdit()) return false;
        const settings = node.data.commerceImageSet;
        if (!settings) return false;
        const assetKeys = node.data.mediaAssetKeys || [];
        const positions = getRemainingCommerceOutputPositions(settings, shotId, assetKeys);
        if (positions.length === assetKeys.length) return removeCommerceSceneShot(settings, shotId);

        const remainingKeys = positions.map(position => assetKeys[position]);
        const cached = projectImageOutput(node, getCanonicalImageList(node)).images;
        const restored = { id: node.id, data: {} };
        const hasCachedBatch = cached.length === assetKeys.length;
        const images = hasCachedBatch ? positions.map(position => cached[position])
            : (await projectMissingMediaAssets({
                workflowId: getActiveWorkflowId(), node: restored, assetKeys: remainingKeys,
                loadAsset: async key => {
                    try { return await getImageAsset(key); } catch { return null; }
                }
            })).map(item => item.value);
        if (!canEdit() || node.data.commerceImageSet !== settings || node.data.mediaAssetKeys !== assetKeys
            || !removeCommerceSceneShot(settings, shotId)) return false;
        setRemainingCommerceOutput(node, positions, remainingKeys, images);
        if (!hasCachedBatch) {
            if (restored.data.mediaIntegrity) node.data.mediaIntegrity = restored.data.mediaIntegrity;
            else delete node.data.mediaIntegrity;
        }
        return true;
    }

    async function readRetainedCommerceImages(settings, rows, signal) {
        const images = new Map();
        for (const row of rows) {
            const key = getCommerceOutputAssetKey(row);
            if (!key) continue;
            const label = settings.plan?.shots.find(shot => shot.id === row.shotId)?.label || row.shotId;
            const message = `无法读取已保存的「${label}」图片，请恢复该图片后重试。`;
            let image;
            try {
                image = await getImageAsset(key);
            } catch (cause) {
                if (isAbortLikeError(cause, signal)) throw cause;
                throw new Error(message, { cause });
            }
            if (!image) throw new Error(message);
            images.set(row.shotId, image);
        }
        signal?.throwIfAborted();
        return images;
    }

    async function publishCommerceShots(node, {
        attempts, batch, firstError, workflowId, signal, commerceShotId, commerceCandidateKey, approvedReferences, appendCandidates = false,
        planToConfirm, sceneToConfirm
    }) {
        // Serializing only publication lets the provider requests proceed independently.
        const previous = commercePublications.get(node) || Promise.resolve();
        const publication = previous.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            const latest = normalizeCommerceImageSetState(node.data?.commerceImageSet);
            const priorRows = new Map(latest.results.map(row => [row.shotId, row]));
            const selectedCandidate = commerceCandidateKey === undefined ? null
                : getCommerceShotCandidates(latest, commerceShotId).find(candidate => candidate.key === commerceCandidateKey);
            if (commerceCandidateKey !== undefined && !selectedCandidate) throw new Error('找不到所选图位的候选图片，请重新打开候选。');
            if (selectedCandidate) {
                const currentShot = latest.plan?.shots.find(shot => shot.id === commerceShotId);
                if (currentShot?.detailAssetKind !== selectedCandidate.draft.detailAssetKind) {
                    throw new Error('这张候选属于旧版详情图，可在历史中查看。请按当前详情方案生成候选。');
                }
                if (currentShot?.detailPageGuideKey !== selectedCandidate.draft.detailPageGuideKey) {
                    throw new Error('这张候选对应上一版详情排版，请按当前详情方案生成候选。');
                }
            }
            if (selectedCandidate && latest.plan?.referenceContentKey) {
                const contentKey = selectedCandidate.referenceContentKey;
                const revision = selectedCandidate.referenceRevision;
                if (contentKey && contentKey !== latest.plan.referenceContentKey) {
                    throw new Error('此候选来自旧参考图，请按当前参考图重新生图。');
                }
                if (!contentKey && (!revision || revision !== latest.plan.referenceRevision)
                    && priorRows.get(commerceShotId)?.assetKey !== selectedCandidate.assetKey) {
                    throw new Error('无法确认此候选的参考图版本，请按当前参考图重新生图。');
                }
            }
            if (commerceShotId && isCommerceShotFinalized(latest, commerceShotId)) throw new Error('图位已定稿，请先解锁。');
            const scopedAttempt = attempts.get(commerceShotId);
            if (scopedAttempt?.status === 'canceled' && !scopedAttempt.images?.length) {
                if (state.nodes.get(node.id) !== node || priorRows.get(commerceShotId)?.assetKey) return;
                priorRows.set(commerceShotId, { shotId: commerceShotId, status: 'canceled' });
                const results = latest.selectedShotIds.flatMap(id => priorRows.has(id) ? [priorRows.get(id)] : []);
                node.data.commerceImageSet = { ...latest, results };
                onNodeResultUpdated(node.id);
                return;
            }
            const rows = batch ? new Map() : new Map(priorRows);
            const superseded = batch?.replacedShotIds || new Set();
            const successful = [];
            const retained = [];
            const pinnedCandidates = [];
            for (const id of latest.selectedShotIds) {
                if (selectedCandidate?.shotId === id) {
                    const { detailAssetKind } = selectedCandidate.draft;
                    const selectedRow = { shotId: id, status: 'completed', assetKey: selectedCandidate.assetKey, planKey: selectedCandidate.planKey,
                        ...(detailAssetKind ? { detailAssetKind } : {}) };
                    rows.set(id, selectedRow);
                    retained.push(selectedRow);
                    continue;
                }
                const result = attempts.get(id);
                const priorRow = priorRows.get(id);
                const keepPrior = appendCandidates || (result?.status === 'canceled' && !!priorRow?.assetKey);
                const canStore = !superseded.has(id) && !priorRow?.finalized && result?.images?.length;
                if (canStore) {
                    successful.push(...result.images.map((image, index) => ({
                        id, image, shot: result.shot, adopt: !keepPrior && index === 0
                    })));
                    if (keepPrior) {
                        const pinned = getCommerceShotCandidates(latest, id).find(candidate => (
                            candidate.assetKey === priorRow?.assetKey && candidate.planKey === priorRow?.planKey
                        ));
                        if (pinned) pinnedCandidates.push({ candidate: pinned, shot: result.shot });
                    }
                }
                const retainOnFailure = batch?.redo && !superseded.has(id) && !priorRow?.finalized
                    && result?.status === 'failed' && priorRow?.assetKey;
                if (retainOnFailure || superseded.has(id) || !result || priorRow?.finalized || keepPrior) {
                    if (priorRow) {
                        const row = retainOnFailure ? { ...priorRow, replacementError: result.error } : priorRow;
                        rows.set(id, row);
                        retained.push(row);
                    }
                    continue;
                }
                rows.set(id, { shotId: id, status: canStore ? 'completed' : result.status, ...(result.error ? { error: result.error } : {}),
                    ...(canStore && result.shot?.detailAssetKind ? { detailAssetKind: result.shot.detailAssetKind } : {}),
                    ...(result.planKey ? { planKey: result.planKey } : {}) });
            }

            if (!successful.length && batch && firstError && !retained.some(row => row.assetKey) && latest.results.some(row => row.assetKey)) {
                throw firstError;
            }
            const retainedImages = await readRetainedCommerceImages(latest, retained, signal);
            const imagesToStore = successful.map(({ image }) => image);
            const assets = imagesToStore.length ? await saveWorkflowNodeMediaAssets(imagesToStore, workflowId, node.id,
                batch ? node.activeMediaOperationId : undefined) : [];
            const keys = assets.map(asset => asset?.asset_key);
            let current;
            try {
                signal?.throwIfAborted();
                if (keys.length !== imagesToStore.length || keys.some(key => !key?.startsWith('media:')) || state.nodes.get(node.id) !== node) {
                    throw new Error('套图生成完成，但工作流媒体保存失败。');
                }
                if (approvedReferences && !sameCommerceReferenceProjection(approvedReferences, projectCommerceReferences(state, node.id))) {
                    throw new Error(COMMERCE_REFERENCE_CHANGED_MESSAGE);
                }
                if (commerceShotId) assertCommercePlanningCurrent(node.id, commerceShotId,
                    selectedCandidate && !approvedReferences ? { ignoreReferences: true } : undefined);
                current = normalizeCommerceImageSetState(node.data?.commerceImageSet);
                if (successful.length && sceneToConfirm && (sceneToConfirm !== JSON.stringify(current.plan?.shots.find(item => item.id === commerceShotId))
                    || !confirmCommerceSceneShot(current, commerceShotId))) throw new Error('该图位方案已更新，请重新确认后生图。');
                if (successful.length && planToConfirm && planToConfirm === JSON.stringify(current.plan)) current.plan.confirmed = true;
            } catch (error) {
                if (assets.length) await releaseWorkflowNodeMediaAssets(assets, workflowId, node.id);
                throw error;
            }

            for (const [id, prior] of priorRows) {
                const shot = current.plan?.shots.find(item => item.id === id);
                if (shot?.source === 'generate' && prior.status === 'completed' && prior.assetKey
                    && shot.detailAssetKind === prior.detailAssetKind
                    && !getCommerceShotCandidates(current, id).some(item => item.assetKey === prior.assetKey && item.planKey === prior.planKey)
                    && (!prior.planKey || prior.planKey === commerceShotPlanKey(shot))) rememberCommerceShotCandidate(current, shot, prior.assetKey);
            }
            const savedCandidates = new Map();
            for (const [index, { id, image, shot, adopt }] of successful.entries()) {
                const key = keys[index];
                if (adopt) {
                    rows.get(id).assetKey = key;
                    retainedImages.set(id, image);
                }
                rememberCommerceShotCandidate(current, shot, key);
                const saved = savedCandidates.get(id) || new Set();
                saved.add(key);
                savedCandidates.set(id, saved);
            }
            for (const { candidate, shot } of pinnedCandidates) {
                if (!getCommerceShotCandidates(current, shot.id).some(item => item.key === candidate.key)) {
                    rememberCommerceShotCandidate(current, { ...shot, ...candidate.draft }, candidate.assetKey);
                }
            }
            for (const [id, saved] of savedCandidates) {
                const total = attempts.get(id)?.candidateProgress?.total;
                if (appendCandidates) continue;
                if (total && saved.size < total) rows.get(id).candidateProgress = { completed: saved.size, total };
                else delete rows.get(id).candidateProgress;
            }
            if (selectedCandidate && !restoreCommerceShotCandidateDraft(current, selectedCandidate)) {
                throw new Error('该图位方案已更新，请重新打开候选。');
            }
            const results = latest.selectedShotIds.flatMap(id => rows.has(id) ? [rows.get(id)] : []);
            const updated = { ...current, results };
            const output = orderCommerceOutputRows(updated).filter(row => getCommerceOutputAssetKey(row));
            const images = output.map(row => retainedImages.get(row.shotId));
            // A rerun of a finished slot supersedes that slot's still-unpublished batch result.
            if (commerceShotId && !appendCandidates && (successful.length || selectedCandidate)) commerceBatches.get(node)?.replacedShotIds.add(commerceShotId);
            node.data.commerceImageSet = updated;
            rememberWorkflowMediaOperation(node, assets);
            if (appendCandidates) {
                onNodeResultUpdated(node.id);
                if (firstError && !successful.length) throw firstError;
                return { image: images, images };
            }
            if (images.length) {
                const assetKeys = output.map(getCommerceOutputAssetKey);
                setCanonicalImageOutput(node, images, { defaultToFirst: true, assetKey: assetKeys[0], imageCount: images.length, assetReady: true });
                node.data.mediaAssetKeys = assetKeys;
                const completedIds = new Set(output.map(row => row.shotId));
                node.generationAttemptIncomplete = results.some(row => !row.finalized && (row.replacementError || row.candidateProgress))
                    || getRunnableCommerceImageSetShots(current).some(shot => !completedIds.has(shot.id));
                try {
                    await propagateImagesToDownstreamPreview(node.id, images);
                } catch (error) {
                    if (!selectedCandidate) throw error;
                    const message = '已采用候选，部分下游预览更新失败。';
                    addLog?.('warning', message, error?.message || String(error), { nodeId: node.id, shotId: commerceShotId });
                    showToast?.(message, 'warning');
                } finally {
                    onNodeResultUpdated(node.id, { downstreamImageResults: true });
                }
                if (getImageHistorySidebarActive()) renderHistoryList();
                if (batch?.redo && firstError && !successful.length
                    && ![...attempts.values()].some(row => row.status === 'completed')) throw firstError;
                return { image: images, images };
            }
            onNodeResultUpdated(node.id);
            if (firstError) throw firstError;
            if (![...attempts.values()].some(row => row.status === 'canceled')) throw new Error('没有可保存的套图结果。');
        });
        commercePublications.set(node, publication);
        try {
            return await publication;
        } finally {
            if (commercePublications.get(node) === publication) commercePublications.delete(node);
        }
    }

    async function executeProductRetouch(node, inputs, signal) {
        signal?.throwIfAborted();
        const images = normalizeImageList(inputs.image);
        if (images.length !== 1 || (Array.isArray(inputs.image) && inputs.image.some(image => !image))) {
            throw new Error('请连接一张完整的商品参考图。');
        }

        const settings = normalizeProductRetouchSettings(node.data?.productRetouch);
        const options = getProductRetouchModelOptions(state, settings);
        if (!options.ready) throw new Error('请选择支持参考图编辑且已配置密钥的模型和供应商。');
        const analysisOptions = getProductRetouchAnalysisModelOptions(state, settings);
        if (!analysisOptions.ready) throw new Error('请选择支持图片输入且已配置密钥的分析模型和供应商。');
        const model = options.models.find(item => item.id === settings.modelId);
        const workflowId = getActiveWorkflowId();
        if (!workflowId) throw new Error('精修结果需要保存到当前工作流。');

        const original = images[0].trim();
        const reference = isRemoteImageUrl(original)
            ? await blobToDataUrl(await downloadGeneratedImage(original, signal)) : original;
        signal?.throwIfAborted();
        if (!/^data:image\/[^;,]+;base64,[A-Za-z0-9+/]+=*$/i.test(reference)) {
            throw new Error('无法读取商品参考图，请重新连接原图。');
        }

        try {
            node.productRetouchStage = 'analyzing';
            onNodeResultUpdated(node.id, { progressOnly: true });
            const analysisModel = analysisOptions.models.find(item => item.id === settings.analysisModelId);
            const analysisProvider = analysisOptions.providers.find(item => item.id === settings.analysisProviderId);
            const request = createProductRetouchAnalysisRequest({ settings, reference, model: analysisModel, provider: analysisProvider });
            const needsGoogleKey = request.protocol === 'google' && analysisProvider.autoComplete === false
                && !/[?&](?:key|api[_-]?key)=[^&#\s]+/i.test(request.url);
            const headers = getProxyHeaders(request.url, request.method, {
                'Content-Type': 'application/json',
                ...(request.protocol === 'openai' ? { Authorization: `Bearer ${analysisProvider.apikey}` } : {}),
                ...(needsGoogleKey ? { 'x-goog-api-key': analysisProvider.apikey } : {})
            });
            const requestForLog = { ...request, requestBody: { model: analysisModel.modelId, referenceImageCount: 1 } };
            const onOutcome = startWorkflowImageRequestLog(node, requestForLog, {
                title: `产品精修 · 分析原图 · ${analysisModel.name || analysisModel.modelId}`, operation: 'analyze', signal
            });
            const analysis = await runTrackedProviderRequest(node, analysisProvider, analysisModel, sanitizeRequestUrl(request.url), async () => {
                const { text } = await requestChatCompletion(request, { fetchRef, headers, signal });
                signal?.throwIfAborted();
                return parseProductRetouchAnalysis(text);
            }, { onOutcome });
            signal?.throwIfAborted();
            node.productRetouchStage = 'retouching';
            node.data.productRetouchAnalysis = analysis;
            onNodeResultUpdated(node.id);
            const prompt = buildProductRetouchPrompt(settings, analysis);
            return await executeProductRetouchImage(node, { model, settings, reference, workflowId, prompt }, signal);
        } finally {
            delete node.productRetouchStage;
            onNodeResultUpdated(node.id, { progressOnly: true });
        }
    }

    async function executeProductRetouchImage(node, { model, settings, reference, workflowId, prompt }, signal) {
        const inputFidelity = getOpenAiImageCapabilities(model.modelId)?.inputFidelities.includes('high') ? 'high' : undefined;
        const { image } = await nodeHandlers.ImageGenerate(node, { referenceImages: [reference] }, signal, {
            preparedImageRequest: {
                prompt,
                referenceFirst: true,
                settings: {
                    apiConfigId: model.id, providerId: settings.providerId, generationCount: 1,
                    protocolParams: { input_fidelity: inputFidelity }
                },
                validateImage: async image => {
                    if (!/^data:image\//i.test(image)) throw new Error('模型返回的内容不是图片，请重试。');
                    const preview = new windowRef.Image();
                    preview.src = image;
                    try { await preview.decode(); }
                    catch { throw new Error('模型返回的图片无法打开，请重试。'); }
                },
                startRequestLog: request => startWorkflowImageRequestLog(node, request, {
                    title: `产品精修 · ${model.name || model.modelId}`, operation: 'retouch', signal
                })
            }
        });
        signal?.throwIfAborted();
        if (!image) throw new Error('供应商未返回精修图片，请重试。');

        const assets = await saveWorkflowNodeMediaAssets([image, reference], workflowId, node.id, node.activeMediaOperationId);
        const savedAssets = assets.filter(asset => typeof asset?.asset_key === 'string' && asset.asset_key.startsWith('media:'));
        if (assets.length !== 2 || savedAssets.length !== 2 || state.nodes.get(node.id) !== node || signal?.aborted) {
            if (savedAssets.length) await releaseWorkflowNodeMediaAssets(savedAssets, workflowId, node.id);
            signal?.throwIfAborted();
            throw new Error('图片已精修，但工作流媒体保存失败。');
        }

        const [resultAsset, originalAsset] = savedAssets;
        const resultAssetKey = resultAsset.asset_key;
        rememberWorkflowMediaOperation(node, savedAssets);
        setCanonicalImageOutput(node, [image], { assetKey: resultAssetKey, imageCount: 1, assetReady: true });
        node.data.mediaAssetKeys = [resultAssetKey];
        node.data.productRetouchComparison = { originalAssetKey: originalAsset.asset_key, resultAssetKey };
        delete node.data.mediaIntegrity;
        if (node.activeMediaOperationId) node.productRetouchResultCommitted = true;
        try {
            await propagateImagesToDownstreamPreview(node.id, [image]);
        } catch {
            addLog('warning', '精修结果已保存，下游预览未更新', '可重新运行预览节点以读取已保存的精修图片。', { nodeId: node.id });
        } finally {
            onNodeResultUpdated(node.id, { downstreamImageResults: true });
        }
        return { image };
    }

    const nodeHandlers = {
        ECommerceImageSet: executeCommerceImageSet,
        VisualStyle: async (node, inputs, signal, { visualStyleFields } = {}) => {
            if (visualStyleFields) {
                const before = visualStyleKey(node.data.visualStyle);
                const references = normalizeImageList(inputs.image);
                const style = await analyzeVisualStyle({ node, references, fields: visualStyleFields, models: state.models,
                    providers: state.providers, fetchRef, getProxyHeaders, signal,
                    runRequest: (request, execute) => {
                        const onOutcome = startWorkflowImageRequestLog(node, request, {
                            title: `画面风格 · 提取风格 · ${request.model.name || request.model.modelId}`, operation: 'analyze-style', signal
                        });
                        return runTrackedProviderRequest(node, request.provider, request.model, sanitizeRequestUrl(request.url), execute, { onOutcome });
                    } });
                if (visualStyleKey(node.data.visualStyle) !== before) throw new Error('风格已编辑，请重新提取。');
                node.data.visualStyle = style;
                onNodeResultUpdated(node.id);
            }
            node.data.style = normalizeVisualStyle(node.data.visualStyle);
        },
        ProductRetouch: executeProductRetouch,
        ImageImport: async (node) => {
            const imageValue = await restoreImageImportOutputValue(node);
            if (!imageValue) throw new Error('未导入图片');
            node.data.image = imageValue;
            if (node.importMode !== 'url') node.imageData = imageValue;
            await refreshDependentImageResizePreviews(node.id);
        },
        ImageResize: async (node, inputs) => {
            const { id } = node;
            const sourceImage = getPrimaryImageInput(inputs.image);
            if (!sourceImage) throw new Error('无输入图片');

            const { resizeMode: mode, scalePercent, targetWidth, targetHeight, keepAspect, quality } = readImageResizeSettings(node);

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
            await saveNodeImageAssetNow(node, result.dataUrl, id);
            await refreshDependentImageResizePreviews(id);
        },
        ColorReset: async (node, inputs) => {
            const sourceImage = getPrimaryImageInput(inputs.image);
            if (!sourceImage) throw new Error('无输入图片');
            const id = node.id;
            const config = readColorResetConfig(node, documentRef);
            const result = await processColorResetImage(sourceImage, config);
            node.data.image = result.dataUrl;
            node.imageData = result.dataUrl;
            node.imageDataList = [result.dataUrl];
            node.colorResetPreviewData = result.dataUrl;
            node.colorResetPreviewMeta = result;
            if (config.whiteBalanceMode === 'auto') node.data.autoWhiteBalanceGains = node.autoWhiteBalanceGains = result.whiteBalanceGains;
            if (config.whiteBalanceMode === 'custom' && result.whiteBalanceAnalysis?.status === 'applied') {
                node.customWhiteBalanceGains = result.whiteBalanceGains;
                node.whiteBalanceGains = result.whiteBalanceGains;
                node.data.customWhiteBalanceGains = node.data.whiteBalanceGains = result.whiteBalanceGains;
            }
            const analysis = result.whiteBalanceAnalysis;
            if (analysis) {
                node.data.whiteBalanceStatus = node.whiteBalanceStatus = analysis.status;
                node.data.whiteBalanceMessage = node.whiteBalanceMessage = analysis.message;
                if (analysis.samplePoint) node.data.whiteBalanceSamplePoint = node.whiteBalanceSamplePoint = analysis.samplePoint;
            }
            restoreColorResetPreview(id, result.dataUrl, result);
            showResolutionBadge(id, result.dataUrl);
            await saveNodeImageAssetNow(node, result.dataUrl, id);
            await refreshDependentImageResizePreviews(id);
        },
        ImageGenerate: async (node, inputs, signal, executionContext = {}) => {
            const { id } = node;
            const prepared = executionContext.preparedImageRequest;
            const singleRetry = executionContext.imageRetry === true;
            const settings = prepared?.settings || readImageGenerationSettings(node, documentRef);
            const errorEl = !prepared && !singleRetry && documentRef.getElementById(`${id}-error`);
            if (errorEl) {
                errorEl.style.display = 'none';
                requestNodeFit(id);
            }
            let targetGenerationCount = 1;
            let sequentialRequestIndex;

            try {
                const styleSnapshot = prepared?.visualStyleSnapshot ?? resolveVisualStyle(state, id, inputs);
                const promptText = prepared?.prompt || buildImageGeneratePrompt(node, inputs);
                node.pendingVisualStyleSnapshot = styleSnapshot;
                const resolved = prepared ? { inputs, prompts: [promptText] }
                    : await resolveRequestMentions(node, inputs, [promptText], { signal });
                inputs = resolved.inputs;
                if (!prepared) assertImageInputCompatibility(node, inputs, settings);
                const configId = settings.apiConfigId;
                const modelCfg = state.models.find((model) => model.id === configId);
                if (!modelCfg) throw new Error('未找到选定的模型配置');
                const selectedProviderId = settings.providerId;
                const resolvedProviderId = getResolvedProviderIdForModel(modelCfg, state.providers, selectedProviderId);
                const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, resolvedProviderId);
                if (!apiCfg) throw new Error('未找到绑定的 API 提供商');
                if (!prepared) node.providerId = resolvedProviderId;

                const quality = settings.quality;
                const moderation = settings.moderation;
                const background = settings.background;
                const searchEnabled = settings.search;
                const [prompt] = resolved.prompts;
                const protocolParams = prepared ? settings.protocolParams : getImageGenerateProtocolParams(node);

                if (!apiCfg.apikey) throw new Error('API 提供商密钥未配置');
                if (!prompt) throw new Error('请输入提示词');

                const protocol = getEffectiveProtocol(modelCfg, apiCfg);
                resolveThinking({ model: modelCfg, provider: apiCfg, task: 'image', protocol }, node.data?.thinking);
                const { aspect, resolution } = readImageGenerateRequestSize(settings, protocol, modelCfg.modelId);
                const isGoogle = protocol === 'google';
                const isTtapi = protocol === 'ttapi';
                const isTtapiOpenAi = protocol === 'ttapi-openai';
                const isNewApiAsyncImage = protocol === 'newapi-image-async';
                const generationCount = singleRetry ? 1 : settings.generationCount;
                targetGenerationCount = generationCount;

                if (isNewApiAsyncImage) {
                    if (prepared) throw new Error('当前节点需要同步生图协议，请切换模型。');
                    return await asyncMediaExecution.runAsyncImageGeneration({
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
                        concurrentRequestStatus: executionContext.concurrentRequestStatus,
                        collectOnly: singleRetry
                    });
                }

                const url = resolveProviderUrl(apiCfg, modelCfg, 'image', { inputs });
                const isOpenAiImageEdit = protocol === 'openai' && /\/images\/edits\/?(?:$|[?#])/i.test(url);
                const mask = isOpenAiImageEdit ? getImageGenerateMask(inputs) : null;
                const buildRequestBody = () => {
                    if (isTtapi) return buildTtapiImageRequest({ modelCfg, prompt, inputs, aspect, resolution, searchEnabled, protocolParams });
                    if (isTtapiOpenAi) return buildTtapiOpenAiImageRequest({ modelCfg, prompt, resolution, quality, moderation, background, inputs, protocolParams });
                    if (isGoogle) return buildGoogleImageRequest({
                        modelId: modelCfg.modelId, prompt, inputs, aspect, resolution, searchEnabled,
                        referenceFirst: prepared?.referenceFirst
                    });
                    return buildOpenAiImageRequest({
                        modelCfg, prompt, resolution, quality, moderation, background, mask, inputs, protocolParams,
                        protocol, url, edit: isOpenAiImageEdit
                    });
                };
                const headers = isGoogle
                    ? getProxyHeaders(url, 'POST')
                    : ((isTtapi || isTtapiOpenAi)
                        ? getProxyHeaders(url, 'POST', {
                            'TT-API-KEY': apiCfg.apikey,
                            'Content-Type': 'application/json'
                        })
                        : getProxyHeaders(url, 'POST', {
                            Authorization: `Bearer ${apiCfg.apikey}`,
                            'Content-Type': isOpenAiImageEdit ? null : 'application/json'
                        }));
                if (!prepared && !singleRetry && !executionContext.concurrentExecution) {
                    resetImageGenerateRunOutputs(node);
                }
                if (!prepared && !singleRetry) {
                    renderNodeApiGenerationProgress(node, {
                        current: executionContext.concurrentExecution ? 0 : node.generationCompletedCount,
                        total: generationCount
                    });
                }

                const shouldRunConcurrentRequests = isConcurrentRequestModeEnabled() &&
                    (generationCount > 1 || executionContext.concurrentExecution);
                if (prepared || singleRetry || shouldRunConcurrentRequests) {
                    const progressTotal = Math.max(1, parseInt(node.apiGenerationProgress?.total ?? generationCount, 10) || generationCount);
                    const generatedImages = new Array(generationCount);
                    const completedBefore = 0;

                    const runSingleGeneration = async (nextGenerationIndex) => {
                        let finishRequestLog;
                        const requestUrl = prepared ? sanitizeRequestUrl(url) : url;
                        return runTrackedProviderRequest(node, apiCfg, modelCfg, requestUrl, async () => {
                            const requestBody = buildRequestBody();
                            applyThinking(requestBody, { model: modelCfg, provider: apiCfg, task: 'image', protocol }, node.data?.thinking);
                            if (!prepared) showToast(
                                generationCount > 1
                                    ? `正在调用 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})...`
                                    : `正在调用 ${modelCfg.name}...`,
                                'info',
                                5000
                            );

                            const requestPayload = isOpenAiImageEdit
                                ? await buildOpenAiImageEditFormData(requestBody, inputs, modelCfg.modelId, value => getReferenceImageBlob(value, signal))
                                : JSON.stringify(requestBody);
                            const loggedRequestBody = isOpenAiImageEdit
                                ? getOpenAiImageRequestLogBody(requestBody, inputs, modelCfg.modelId)
                                : requestBody;
                            if (prepared) {
                                finishRequestLog = prepared.startRequestLog({
                                    model: modelCfg, provider: apiCfg, url: requestUrl, protocol, requestBody: loggedRequestBody
                                });
                            } else {
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
                            }

                            const response = await fetchRef('/proxy', {
                                method: 'POST',
                                headers,
                                body: requestPayload,
                                signal
                            });

                            let result;
                            if (!response.ok) {
                                const t = await response.text();
                                result = await recoverImageResultFromFailedResponse(t, response.headers.get('content-type') || '', {
                                    apiCfg,
                                    modelCfg,
                                    url,
                                    requestBody,
                                    status: response.status
                                });
                                if (!result) {
                                    const errorContext = buildProviderErrorContext(apiCfg, modelCfg, url);
                                    const err = new Error(formatProxyErrorMessage(response.status, t, 'API 错误', errorContext));
                                    err.serverResponse = { url, requestBody, status: response.status, body: t };
                                    applyUserFacingError(err, classifyProviderError(response.status, t, errorContext));
                                    throw err;
                                }
                            } else {
                                result = await parseJsonResponseOrThrow(response, { apiCfg, modelCfg, url, requestBody });
                            }
                            if (!result) throw new Error('API 返回了空的 JSON 响应');

                            let imageData = '';
                            const imageResult = extractImageResult(apiCfg, result, modelCfg, requestBody.output_format);
                            if (imageResult?.dataUrl) {
                                imageData = imageResult.dataUrl;
                                if (imageResult.recovered) {
                                    showToast('服务器响应异常，已从返回内容中恢复出图片。', 'warning', 6000);
                                    addLog('warning', '图片响应兜底恢复成功', '服务器返回内容无法按标准 JSON 解析，但后端恢复模块已从响应中提取出图片。', {
                                        nodeId: id,
                                        model: modelCfg.name,
                                        recoverySource: imageResult.recoverySource || 'backend'
                                    });
                                }
                            } else if (imageResult?.url) {
                                const imgBlob = await downloadGeneratedImage(imageResult.url, signal);
                                imageData = await blobToDataUrl(imgBlob);
                            }

                            if (!imageData) {
                                const err = new Error(getImageGenerationError(apiCfg, result, modelCfg));
                                err.serverResponse = JSON.stringify(result, null, 2);
                                throw err;
                            }

                            await prepared?.validateImage?.(imageData);
                            return imageData;
                        }, {
                            nodeType: 'ImageGenerate',
                            onOutcome: prepared ? (success, error) => finishRequestLog?.(success, error) : undefined
                        });
                    };

                    const requestIndexes = Array.from(
                        { length: generationCount - completedBefore },
                        (_, offset) => completedBefore + offset
                    );
                    const markConcurrentRequestStatus = (relativeIndex, status, error = null, image = '') => {
                        executionContext.concurrentRequestStatus?.markRequestStatus?.(relativeIndex, status, error, image);
                    };
                    const requestResults = await Promise.allSettled(requestIndexes.map((index) => {
                        const nextGenerationIndex = index + 1;
                        markConcurrentRequestStatus(index, 'running');
                        return runRequestWithRetries(() => runSingleGeneration(nextGenerationIndex), {
                            label: generationCount > 1
                                ? `图片生成 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})`
                                : `图片生成 ${modelCfg.name}`,
                            signal
                        }).then(async (image) => {
                            if (prepared || singleRetry) signal?.throwIfAborted();
                            await saveImageGenerationHistoryEntry({
                                nodeId: id,
                                image,
                                prompt,
                                model: modelCfg.name,
                                generationDurationSeconds: getNodeGenerationDurationSeconds(node)
                            });
                            generatedImages[index] = image;
                            if (!prepared && !singleRetry) {
                                incrementNodeApiGenerationProgress(node, 1, {
                                    current: nextGenerationIndex,
                                    total: progressTotal
                                });
                            }
                            if (getImageHistorySidebarActive()) renderHistoryList();
                            if (!singleRetry) markConcurrentRequestStatus(index, 'success', null, image);
                        }).catch((error) => {
                            if (!singleRetry) markConcurrentRequestStatus(index, isAbortLikeError(error, signal) ? 'canceled' : 'failed', error);
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
                        if (prepared || singleRetry) throw rejectedRequests[0].reason;
                        node.generationAttemptIncomplete = true;
                        if (!executionContext.concurrentExecution) {
                            commitImageGenerateOutputs(node, completedImages, prompt, signal);
                            await refreshDependentImageResizePreviews(id);
                            connectionProjection?.nodeGeometryChanged(id);
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

                    if (!prepared && !singleRetry && !executionContext.concurrentExecution) {
                        commitImageGenerateOutputs(node, completedImages, prompt, signal);
                        node.isSucceeded = true;
                        await refreshDependentImageResizePreviews(id);
                        connectionProjection?.nodeGeometryChanged(id);
                    }

                    return {
                        image: completedImages[completedImages.length - 1] || '',
                        images: completedImages.slice(),
                        ...(singleRetry ? { prompt } : {})
                    };
                }

                while (node.generationCompletedCount < generationCount) {
                    const nextGenerationIndex = node.generationCompletedCount + 1;
                    const currentRequestIndex = nextGenerationIndex - 1;
                    sequentialRequestIndex = currentRequestIndex;
                    executionContext.concurrentRequestStatus?.markRequestStatus?.(currentRequestIndex, 'running');
                    renderNodeApiGenerationProgress(node, {
                        current: node.generationCompletedCount,
                        total: generationCount
                    });
                    const requestBody = buildRequestBody();
                    applyThinking(requestBody, { model: modelCfg, provider: apiCfg, task: 'image', protocol }, node.data?.thinking);
                    showToast(
                        generationCount > 1
                            ? `正在调用 ${modelCfg.name} (${nextGenerationIndex}/${generationCount})...`
                            : `正在调用 ${modelCfg.name}...`,
                        'info',
                        5000
                    );

                    const requestPayload = isOpenAiImageEdit
                        ? await buildOpenAiImageEditFormData(requestBody, inputs, modelCfg.modelId, value => getReferenceImageBlob(value, signal))
                        : JSON.stringify(requestBody);
                    const loggedRequestBody = isOpenAiImageEdit
                        ? getOpenAiImageRequestLogBody(requestBody, inputs, modelCfg.modelId)
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

                    const requestResult = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
                        const response = await fetchRef('/proxy', {
                            method: 'POST',
                            headers,
                            body: requestPayload,
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
                            if (recoveredResult) {
                                const imageResult = extractImageResult(apiCfg, recoveredResult, modelCfg);
                                if (imageResult?.dataUrl) {
                                    return {
                                        recovered: true,
                                        imageData: imageResult.dataUrl
                                    };
                                }
                            }
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
                        const imageResult = extractImageResult(apiCfg, result, modelCfg, requestBody.output_format);
                        if (imageResult?.dataUrl) {
                            imageData = imageResult.dataUrl;
                            if (imageResult.recovered) {
                                showToast('服务器响应异常，已从返回内容中恢复出图片。', 'warning', 6000);
                                addLog('warning', '图片响应兜底恢复成功', '服务器返回内容无法按标准 JSON 解析，但后端恢复模块已从响应中提取出图片。', {
                                    nodeId: id,
                                    model: modelCfg.name,
                                    recoverySource: imageResult.recoverySource || 'backend'
                                });
                            }
                        } else if (imageResult?.url) {
                            const imgBlob = await downloadGeneratedImage(imageResult.url, signal);
                            imageData = await blobToDataUrl(imgBlob);
                        }

                        if (!imageData) {
                            const err = new Error(getImageGenerationError(apiCfg, result, modelCfg));
                            err.serverResponse = JSON.stringify(result, null, 2);
                            throw err;
                        }

                        return { imageData };
                    }, { nodeType: 'ImageGenerate' });

                    const imageData = requestResult.imageData;
                    await saveImageGenerationHistoryEntry({
                        nodeId: id,
                        image: imageData,
                        prompt,
                        model: modelCfg.name,
                        generationDurationSeconds: getNodeGenerationDurationSeconds(node)
                    });
                    if (requestResult.recovered) {
                        const generatedImages = getCanonicalImageList(node, { includeResizePreview: false }).slice(0, nextGenerationIndex);
                        generatedImages[nextGenerationIndex - 1] = imageData;
                        commitImageGenerateOutputs(node, generatedImages.slice(0, nextGenerationIndex), prompt, signal);
                        executionContext.concurrentRequestStatus?.markRequestStatus?.(currentRequestIndex, 'success', null, imageData);
                        incrementNodeApiGenerationProgress(node, 1, {
                            current: nextGenerationIndex,
                            total: generationCount
                        });
                        await refreshDependentImageResizePreviews(id);
                        if (getImageHistorySidebarActive()) renderHistoryList();
                        node.generationCompletedCount = nextGenerationIndex;
                        continue;
                    }

                    const generatedImages = getCanonicalImageList(node, { includeResizePreview: false }).slice(0, nextGenerationIndex);
                    generatedImages[nextGenerationIndex - 1] = imageData;
                    commitImageGenerateOutputs(node, generatedImages.slice(0, nextGenerationIndex), prompt, signal);
                    executionContext.concurrentRequestStatus?.markRequestStatus?.(currentRequestIndex, 'success', null, imageData);
                    incrementNodeApiGenerationProgress(node, 1, {
                        current: nextGenerationIndex,
                        total: generationCount
                    });
                    await refreshDependentImageResizePreviews(id);
                    if (getImageHistorySidebarActive()) renderHistoryList();
                }
            } catch (err) {
                if (prepared || singleRetry) throw err;
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
                if (Number.isInteger(sequentialRequestIndex)) {
                    executionContext.concurrentRequestStatus?.markRequestStatus?.(sequentialRequestIndex, 'failed', err);
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
        VideoGenerate: async (node, inputs, signal, { videoExecutionInput } = {}) => {
            if (videoExecutionInput?.valid) {
                const { controls, prompt, projection } = videoExecutionInput;
                const systemPrompt = String(controls.protocolParams?.systemPrompt || '');
                const resolved = await resolveRequestMentions(node, videoExecutionInput.inputs, [prompt, systemPrompt], { signal, videoPorts: projection?.ports });
                if (resolved.inputs !== videoExecutionInput.inputs) {
                    videoExecutionInput = { ...videoExecutionInput, inputs: resolved.inputs, prompt: resolved.prompts[0],
                        controls: { ...controls, protocolParams: { ...controls.protocolParams, systemPrompt: resolved.prompts[1] } } };
                }
            }
            return asyncMediaExecution.runVideoGenerateNode(node, inputs, signal, videoExecutionInput);
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

            const resolved = await resolveRequestMentions(node, inputs, readTextChatPrompts(node, inputs), { signal });
            const [prompt, sysprompt] = resolved.prompts;
            inputs = resolved.inputs;
            const responseArea = documentRef.getElementById(`${id}-response`);

            if (!apiCfg.apikey) throw new Error('API 提供商密钥未配置');
            if (!prompt) throw new Error('请输入提问内容');

            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
            responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';
            renderNodeApiGenerationProgress(node, { current: 0, total: 1 });

            try {
                let jsonResponse = null;
                let responseText = '';
                const chatPlan = createChatRequestPlan({
                    provider: apiCfg,
                    model: modelCfg,
                    protocol: getEffectiveProtocol(modelCfg, apiCfg),
                    systemPrompt: sysprompt,
                    messages: [{ role: 'user', content: getPrimaryTextInput(prompt) }],
                    media: getOpenAiImageContents(inputs).map((item) => ({ type: 'image', url: item.image_url.url })),
                    searchEnabled: documentRef.getElementById(`${id}-search`)?.checked || false,
                    thinking: node.data?.thinking,
                    customParams: inputs.params
                });
                const { protocol, url, requestBody } = chatPlan;

                if (protocol === 'google') {
                    const body = requestBody;

                    const headers = getProxyHeaders(url, 'POST');
                    logRequestToPanel(`请求发送: ${modelCfg.name}`, url, body, {
                        nodeId: id,
                        nodeType: 'TextChat',
                        providerType: protocol
                    });

                    responseText = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
                        const res = await executeChatRequestPlan(chatPlan, { fetchRef, headers, signal });
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

                        let resultText = jsonResponse.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
                        if (jsonResponse.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.html) {
                            resultText += `\n\n<div class="search-chips">${jsonResponse.candidates[0].groundingMetadata.searchEntryPoint.html}</div>`;
                        }
                        if (!String(resultText || '').trim()) {
                            const err = new Error('API 返回了空回复。');
                            err.serverResponse = JSON.stringify(jsonResponse, null, 2);
                            throw err;
                        }
                        return resultText;
                    }, { nodeType: 'TextChat' });
                } else {
                    const headers = getProxyHeaders(url, 'POST', {
                        Authorization: `Bearer ${apiCfg.apikey}`
                    });
                    logRequestToPanel(`请求发送: ${modelCfg.name}`, url, requestBody, {
                        nodeId: id,
                        nodeType: 'TextChat',
                        providerType: protocol
                    });

                    responseText = await runTrackedProviderRequest(node, apiCfg, modelCfg, url, async () => {
                        const res = await executeChatRequestPlan(chatPlan, { fetchRef, headers, signal });
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
                        const resultText = jsonResponse.choices?.[0]?.message?.content || '';
                        if (!String(resultText || '').trim()) {
                            const err = new Error('API 返回了空回复。');
                            err.serverResponse = JSON.stringify(jsonResponse, null, 2);
                            throw err;
                        }
                        return resultText;
                    }, { nodeType: 'TextChat' });
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
                    connectionProjection?.nodeGeometryChanged(id);
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
            } else node.previewInputState = resolveImagePreviewInputState(node, []);
            requestNodeFit(id);
        },
        ImageCompare: async (node, inputs) => {
            const { id } = node;
            const primary = port => {
                const edge = state.connections.find(connection => connection.to?.nodeId === id && connection.to?.port === port);
                const source = state.nodes.get(edge?.from?.nodeId);
                if (source?.enabled === false || source?.data?.mediaIntegrity?.missingItems?.some(item => Number(item.position) === 0)) return '';
                const value = inputs[port];
                return Array.isArray(value) ? (typeof value[0] === 'string' ? value[0] : '') : getPrimaryImageInput(value);
            };
            const imageA = primary('imageA');
            const imageB = primary('imageB');
            if (!imageB) {
                await syncImageCompareNode(id, null, null);
                const error = new Error('B 输入未连接图片');
                error.inputPort = 'imageB';
                throw error;
            }
            await syncImageCompareNode(id, imageA || null, imageB);
            await refreshDependentImageResizePreviews(id);
        },
        ImageMerge: async (node, inputs = {}) => {
            const previousIndex = Number.isFinite(node.imagePreviewIndex) ? node.imagePreviewIndex : 0;
            const images = await readMergeInputImages(node, inputs);
            if (images.length === 0) {
                await syncImageMergeNode(node.id, []);
                throw new Error('请至少连接一张图片');
            }
            setCanonicalImageOutput(node, images, {
                currentIndex: previousIndex,
                assetKey: node.id
            });
            await saveNodeImageAssetNow(node, images, node.id);
            await syncImageMergeNode(node.id, images);
            await refreshDependentImageResizePreviews(node.id);
            connectionProjection?.nodeGeometryChanged(node.id);
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
            connectionProjection?.nodeGeometryChanged(node.id);
        },
        ImageSave: async (node, inputs) => {
            const { id } = node;
            const imageList = normalizeImageList(inputs.image);
            const videoList = (Array.isArray(inputs.video) ? inputs.video : [inputs.video])
                .filter((video) => video && typeof video === 'object' && (video.url || video.assetKey));
            const previewVideo = videoList[videoList.length - 1] || null;
            const payload = { images: imageList, video: previewVideo, videos: videoList };
            if (imageList.length > 0 || videoList.length > 0) {
                await syncImageSaveNode(id, payload);
            } else {
                applyImageSaveMediaState(node, payload);
                const preview = node.el?.querySelector?.(`#${id}-save-preview`);
                if (preview) {
                    preview.dataset.saveState = node.saveInputState;
                    if (node.saveInputMessage) preview.dataset.saveMessage = node.saveInputMessage;
                    else delete preview.dataset.saveMessage;
                }
            }
            if (imageList.length > 0) {
                await refreshDependentImageResizePreviews(id);
            }
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
            node.el?._refreshTextReader?.();
            connectionProjection?.nodeGeometryChanged(node.id);
        },
        CameraControl: async (node, inputs = {}) => {
            const edge = state.connections.find(edge => edge.to.nodeId === node.id && edge.to.port === 'image');
            const source = edge && state.nodes.get(edge.from.nodeId);
            const input = Array.isArray(inputs.image) ? inputs.image[0] : inputs.image;
            const missing = source?.data?.mediaIntegrity?.missingItems?.some(item => item.position === 0);
            node.data.image = source?.enabled === false || missing ? '' : getPrimaryImageInput(input);
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
            await syncCameraControlNode(node.id, node.data.image);
            connectionProjection?.nodeGeometryChanged(node.id);
        },
        TextSplit: async (node, inputs = {}) => {
            const delimiterInput = documentRef.getElementById(`${node.id}-delimiter`);
            const outputCountInput = documentRef.getElementById(`${node.id}-output-count`);
            const removeEmptyLinesInput = documentRef.getElementById(`${node.id}-remove-empty-lines`);
            const mergeOutputEnabledInput = documentRef.getElementById(`${node.id}-merge-output-enabled`);
            const hasIncomingText = Object.prototype.hasOwnProperty.call(inputs, 'text');
            const text = hasIncomingText ? getPrimaryTextInput(inputs.text) : (node.data.text || '');
            const delimiter = delimiterInput?.value ?? node.data.delimiter ?? '';
            const parsedOutputCount = parseInt(outputCountInput?.value ?? node.data.outputCount ?? '0', 10);
            const removeEmptyLines = removeEmptyLinesInput
                ? removeEmptyLinesInput.checked === true
                : node.data?.removeEmptyLines === true;
            const mergeOutputEnabled = mergeOutputEnabledInput
                ? mergeOutputEnabledInput.checked === true
                : node.data?.mergeOutputEnabled === true;
            const outputCount = mergeOutputEnabled
                ? 0
                : (Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 0);
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
            connectionProjection?.nodeGeometryChanged(node.id);
            return mergeOutputEnabled
                ? { text: parts.slice() }
                : parts.reduce((outputs, part, index) => {
                    outputs[`part_${index + 1}`] = part;
                    return outputs;
                }, {});
        }
    };

    async function executeNode(node, inputs, signal, executionContext = {}) {
        if (node.type === 'ImageImport') {
            const imageValue = await restoreImageImportOutputValue(node);
            if (!imageValue) {
                delete node.data.image;
                throw new Error('未导入图片');
            }
            node.data.image = imageValue;
            if (node.importMode !== 'url') {
                node.imageData = imageValue;
                node.data.imageCount = Math.max(1, parseInt(node.data.imageCount || '1', 10) || 1);
                if (node.imageImportAssetKey || node.data.imageImportAssetKey) {
                    node.data.imageImportAssetKey = node.imageImportAssetKey || node.data.imageImportAssetKey;
                    delete node.data.imageAssetKey;
                } else if (node.data.imageAssetKey) {
                    node.data.imageAssetKey = node.data.imageAssetKey;
                }
                if (node.data.imageImportAssetKey || node.data.imageAssetKey) {
                    node.data.imageAssetReady = true;
                }
            } else {
                delete node.data.imageAssetKey;
                delete node.data.imageAssetReady;
            }
            delete node.data.imageMemoryReleased;
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
            const configId = node.type === 'ImageGenerate' ? readImageGenerationSettings(node, documentRef).apiConfigId : documentRef.getElementById(`${node.id}-apiconfig`)?.value || '';
            const modelCfg = state.models.find((model) => model.id === configId);
            const selectedProviderId = node.type === 'ImageGenerate' ? readImageGenerationSettings(node, documentRef).providerId : documentRef.getElementById(`${node.id}-provider`)?.value || node.providerId || '';
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
        waitForPendingImageAssetSaves,
        normalizeRunOptions,
        resolveExecutionPlan,
        topologicalSort,
        getCachedOutputValue,
        isFixedTextChatWithCachedResult,
        buildNodeRequestPreview,
        captureSceneReferenceImages,
        downloadGeneratedImage,
        downloadGeneratedVideo,
        resumeVideoGeneration: asyncMediaExecution.resumeVideoGeneration,
        resumeAsyncImageGeneration: asyncMediaExecution.resumeAsyncImageGeneration,
        recoverAsyncImageTaskMedia: asyncMediaExecution.recoverAsyncImageTaskMedia,
        recoverVideoTaskMedia: asyncMediaExecution.recoverVideoTaskMedia,
        removeCommerceScene,
        executeNode,
        nodeHandlers
    };
}
