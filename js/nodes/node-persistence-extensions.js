// Names owned by the current node model. This catalog reserves fields only;
// control readers and media serializers remain their sole value authorities.
const knownFields = new Set(`
    id type x y width height userResized collapsed collapsedExpandedHeight collapsedCollapsedExpandedHeight enabled lastDuration
    isClone cloneSourceId customTitle defaultTitle data thinking textareaHeights chatLayoutVersion commerceImageSet imagePromptMentions
    prompt sysprompt negativePrompt apiConfigId providerId aspect aspectRatio resolution customWidth customHeight customResolution
    quality moderation background search fixed generationCount generationCompletedCount referenceImageCount referenceImageInputCount
    advancedExpanded protocolParams protocolVariantDrafts protocolVariantKey generationRevision generationDirty generationAttemptIncomplete
    apiGenerationProgress executionFailure isSucceeded isFailed runStatus runStartedAt lastResponse lastText
    image imageData imageDataList images imageList imagePromptList imageAssetKey imageImportAssetKey mediaAssetKeys imageAssetReady imageCount
    imagePreviewIndex imagePreviewThumbnail imageHydratedAt imageMemoryReleased imageResultPersistence mediaIntegrity
    previewInputState saveInputState saveInputMessage
    resizePreviewData resizePreviewMeta colorResetPreviewData colorResetPreviewMeta
    imageDescription imageDescriptions importMode imageUrl previewZoom
    imageTaskId imageTaskStatus imageTaskStatusText imageTaskUrl imageTaskCreateHttpStatus imageTaskCreateStatus imageTaskProgress concurrentRequestStatus
    compareImageA compareImageB compareInputState comparePosition mergeInputState mergeMessage inputCount imageMergeInputCount textMergeInputCount
    resizeMode scalePercent targetWidth targetHeight keepAspect originalWidth originalHeight outputWidth outputHeight outputFormat outputQuality estimatedBytes
    whiteBalanceMode whiteBalanceGains customWhiteBalanceGains autoWhiteBalanceGains whiteBalanceSamplePoint whiteBalanceStatus whiteBalanceMessage
    temperature tint vibrance saturation
    filename autoAddedForGeneration savePreviewMode videoPreviewIndex video videos videoId videoUrl videoAssetKey videoStatus videoStatusText
    videoCreateHttpStatus videoCreateStatus videoStatusUpdateTime videoEnhancedPrompt videoMissingLocalAsset
    useVideoSizeParam enhancePrompt enableUpsample doubaoResolution doubaoDuration doubaoCameraFixed doubaoGenerateAudio doubaoWatermark doubaoSeed
    text texts textPreviewIndex delimiter outputCount removeEmptyLines previewEnabled mergeOutputEnabled parts params customParams
    pitch yaw distance fov roll cameraViewMode cameraPrompt cameraPreviewImage agentReferenceSource
`.trim().split(/\s+/));

const extensions = new WeakMap();
const workflowFields = new Set(`
    canvas nodes connections promptAgent version workflowId mediaOwnershipRevision mediaOwnershipRestoreOwnerIds type
    providers models apikey apiKey apiKeys apiEndpoint endpoint apiConfig apiConfigs apiSettings apiKeyMap modelApiKey
    nodeDefaults themeId themeMode notificationsEnabled notificationVolume autoRetry maxRetries concurrentRequestMode
    imageAutoResizeEnabled imageSaveUsePromptFilename imageMaxPixels connectionLineType toolbarPinned sidebarPinned
    globalAnimationEnabled connectionFlowAnimationEnabled canvasRender proxy requestTimeoutEnabled requestTimeoutSeconds
    videoRequestTimeoutEnabled videoRequestTimeoutSeconds autoCheckUpdatesOnLoad historyGridCols workflowSidebarWidth
`.trim().split(/\s+/));
const canvasFields = new Set(['x', 'y', 'zoom']);

function cloneJson(value, parents = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (!value || typeof value !== 'object' || parents.has(value)) return undefined;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    parents.add(value);
    const copy = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(value, index);
        return property && 'value' in property ? cloneJson(property.value, parents) : undefined;
    })
        : Object.fromEntries(Object.keys(value).flatMap(key => {
            const property = Object.getOwnPropertyDescriptor(value, key);
            const item = property && 'value' in property ? cloneJson(property.value, parents) : undefined;
            return item === undefined ? [] : [[key, item]];
        }));
    parents.delete(value);
    return Array.isArray(copy) && copy.some(item => item === undefined) ? undefined : copy;
}

function unknownFields(record, reserved = knownFields) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
    return Object.fromEntries(Object.keys(record).flatMap(key => {
        if (reserved.has(key)) return [];
        const property = Object.getOwnPropertyDescriptor(record, key);
        const value = property && 'value' in property ? cloneJson(property.value) : undefined;
        return value === undefined ? [] : [[key, value]];
    }));
}

/** Retain only opaque JSON extensions, never a second copy of known node state. */
export function captureNodePersistenceExtensions(node, restoreData) {
    if (!node || typeof node !== 'object') return;
    const dataProperty = restoreData && typeof restoreData === 'object' ? Object.getOwnPropertyDescriptor(restoreData, 'data') : null;
    const root = unknownFields(restoreData), data = unknownFields(dataProperty && 'value' in dataProperty ? dataProperty.value : null);
    if (Object.keys(root).length || Object.keys(data).length) extensions.set(node, { root, data });
    else extensions.delete(node);
}

/** Both visible and detached node writers apply the same extension boundary. */
export function applyNodePersistenceExtensions(node, serialized) {
    const retained = extensions.get(node);
    if (!retained) return serialized;
    const root = unknownFields(retained.root), data = unknownFields(retained.data);
    return { ...root, ...serialized,
        ...(Object.keys(data).length ? { data: { ...data, ...serialized.data } } : {}) };
}

/** Standalone workflows retain extensions while legacy application settings stay private. */
export function applyWorkflowPersistenceExtensions(previousData, knownPayload) {
    const canvasProperty = previousData && typeof previousData === 'object' ? Object.getOwnPropertyDescriptor(previousData, 'canvas') : null;
    const canvas = canvasProperty && 'value' in canvasProperty ? canvasProperty.value : null;
    return { ...unknownFields(previousData, workflowFields), ...knownPayload,
        canvas: { ...unknownFields(canvas, canvasFields), ...knownPayload.canvas } };
}
