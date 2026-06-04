/**
 * Manages memory release and on-demand restore for display image nodes.
 */
import {
    getFirstNonEmptyImageList,
    getCanonicalImageList,
    setCanonicalImageOutput
} from '../execution/execution-data-utils.js';

const DISPLAY_IMAGE_RELEASE_PADDING = 900;
const DISPLAY_IMAGE_HYDRATE_PADDING = 420;
const DISPLAY_IMAGE_SWEEP_DELAY_MS = 180;
const DISPLAY_IMAGE_RELEASE_GRACE_MS = 3500;
const DISPLAY_IMAGE_MAX_RESTORE_PER_SWEEP = 4;
const FALLBACK_DISPLAY_NODE_WIDTH = 220;
const FALLBACK_DISPLAY_NODE_HEIGHT = 180;

export function createDisplayImageMemoryManager({
    state,
    getNodeById,
    getImageAsset = async () => null,
    getImageAssetList = async () => [],
    saveImageAsset = async () => false,
    saveImageAssetList = async () => false,
    deleteImageAsset = null,
    normalizeImageList = () => [],
    isInlineImageData = () => false,
    getNodeOutputImageListAsync = async () => [],
    getImagePreviewIndex = (node, images) => {
        if (!Array.isArray(images) || images.length === 0) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
    },
    renderImagePreviewImage = () => {},
    renderImageSavePreview = () => {},
    renderImageImportUploadState = () => {},
    renderImageResizeResult = () => {},
    renderImageComparePreview = () => {},
    showResolutionBadge = async () => {},
    ensureElement = null,
    removeElements = null,
    createPreviewPlaceholder = null,
    updatePreviewPlaceholder = null,
    createPreviewNavButton = null,
    documentRef = document,
    windowRef = window,
    canvasContainer = null
}) {
    const displayImageAssetState = new Map();
    const fullscreenPreviewNodeIds = new Set();
    let displayImageMemorySweepTimer = null;
    let displayImageMemorySweepRunning = false;
    let displayImageMemorySweepQueued = false;
    let displayImageAssetSaveSequence = 0;

    function runBackgroundMediaTask(task, label = 'Background media task failed:') {
        if (typeof task !== 'function') return;
        try {
            const result = task();
            if (result && typeof result.catch === 'function') {
                result.catch((error) => console.warn(label, error));
            }
        } catch (error) {
            console.warn(label, error);
        }
    }

    function isDisplayImageNode(node) {
        return node?.type === 'ImagePreview' || node?.type === 'ImageSave';
    }

    function isImageImportUploadNode(node) {
        return node?.type === 'ImageImport' && node.importMode !== 'url';
    }

    function isManagedImageNode(node) {
        return isDisplayImageNode(node)
            || node?.type === 'ImageGenerate'
            || node?.type === 'ImageResize'
            || node?.type === 'ImageCompare'
            || isImageImportUploadNode(node);
    }

    function getStoredImageAssetKey(node) {
        if (!node) return '';
        if (isImageImportUploadNode(node)) {
            return [
                node.imageImportAssetKey,
                node.data?.imageImportAssetKey,
                node.id ? `image-import:${node.id}` : '',
                node.data?.imageAssetKey
            ].find((key) => typeof key === 'string' && key.trim()) || '';
        }
        if (typeof node.data?.imageAssetKey === 'string' && node.data.imageAssetKey) {
            return node.data.imageAssetKey;
        }
        if (node.type === 'ImageGenerate' || node.type === 'ImageResize' || node.type === 'ImageCompare') {
            return node.id || '';
        }
        return '';
    }

    function getStoredImageCount(node) {
        const explicitCount = Math.max(0, parseInt(node?.data?.imageCount || '0', 10) || 0);
        const inMemoryCount = getManagedNodeImageList(node).length;
        return Math.max(explicitCount, inMemoryCount);
    }

    function getManagedNodeImageList(node) {
        if (!node) return [];
        if (node.type === 'ImageResize') {
            return getFirstNonEmptyImageList(
                node.data?.imageList,
                node.data?.images,
                node.imageDataList,
                node.generatedImages,
                node.data?.image,
                node.imageData,
                node.resizePreviewData
            );
        }
        if (isImageImportUploadNode(node)) {
            return getFirstNonEmptyImageList(
                node.data?.imageList,
                node.data?.images,
                node.imageDataList,
                node.data?.image,
                node.imageData
            );
        }
        if (node.type === 'ImageCompare') {
            return getFirstNonEmptyImageList(
                node.data?.image,
                node.data?.compareImageB,
                node.compareImageB,
                node.imageData
            );
        }
        return getCanonicalImageList(node, { includeResizePreview: false });
    }

    function setAssetState(nodeId, status, extra = {}) {
        if (!nodeId) return;
        const current = displayImageAssetState.get(nodeId) || {};
        displayImageAssetState.set(nodeId, {
            ...current,
            ...extra,
            status,
            updatedAt: Date.now()
        });
    }

    function clearAssetState(nodeId) {
        if (nodeId) displayImageAssetState.delete(nodeId);
    }

    function isDisplayImageAssetReady(node) {
        const assetKey = getStoredImageAssetKey(node);
        if (!assetKey) return false;
        const stateEntry = displayImageAssetState.get(assetKey) || displayImageAssetState.get(node?.id);
        return node?.data?.imageAssetReady === true
            || node?.data?.imageMemoryReleased === true
            || stateEntry?.status === 'ready';
    }

    function updateResolutionBadgeSoon(nodeId, dataUrl) {
        if (!dataUrl || typeof showResolutionBadge !== 'function') return;
        runBackgroundMediaTask(() => showResolutionBadge(nodeId, dataUrl), 'Show image resolution failed:');
    }

    function saveAssetSoon(nodeId, images) {
        const imageList = normalizeImageList(images);
        const currentImage = imageList[0] || null;
        const node = getNodeById(nodeId);
        if (node?.data) delete node.data.imageAssetReady;
        const saveToken = displayImageAssetSaveSequence += 1;
        const isCurrentSave = () => displayImageAssetState.get(nodeId)?.token === saveToken;
        const markReady = () => {
            if (!isCurrentSave()) return;
            const latestNode = getNodeById(nodeId);
            if (latestNode?.data) latestNode.data.imageAssetReady = true;
            setAssetState(nodeId, 'ready');
            scheduleSweep({ delayMs: DISPLAY_IMAGE_RELEASE_GRACE_MS });
        };
        const markFailed = () => {
            if (!isCurrentSave()) return;
            const latestNode = getNodeById(nodeId);
            if (latestNode?.data) delete latestNode.data.imageAssetReady;
            setAssetState(nodeId, 'failed');
        };
        setAssetState(nodeId, 'pending', { token: saveToken });
        const saveTask = imageList.length > 1 && typeof saveImageAssetList === 'function'
            ? () => saveImageAssetList(nodeId, imageList)
            : (isInlineImageData(currentImage) && typeof saveImageAsset === 'function'
                ? () => saveImageAsset(nodeId, currentImage)
                : null);
        if (saveTask) {
            runBackgroundMediaTask(async () => {
                const ok = await saveTask();
                if (ok) markReady();
                else markFailed();
            }, 'Save display image asset failed:');
            return;
        }
        if (deleteImageAsset) {
            runBackgroundMediaTask(async () => {
                await deleteImageAsset(nodeId);
                displayImageAssetState.delete(nodeId);
            }, 'Delete display image asset failed:');
        } else {
            displayImageAssetState.delete(nodeId);
        }
    }

    function getDisplayImageViewport() {
        const container = canvasContainer || documentRef.getElementById('canvas-container') || null;
        if (!container) return null;
        const rect = typeof container.getBoundingClientRect === 'function'
            ? container.getBoundingClientRect()
            : null;
        const width = rect?.width || container.clientWidth || 0;
        const height = rect?.height || container.clientHeight || 0;
        const zoom = Number(state.canvas?.zoom) > 0 ? Number(state.canvas.zoom) : 1;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || zoom <= 0) {
            return null;
        }
        const x = Number(state.canvas?.x) || 0;
        const y = Number(state.canvas?.y) || 0;
        return {
            left: -x / zoom,
            top: -y / zoom,
            right: (width - x) / zoom,
            bottom: (height - y) / zoom,
            centerX: (width / 2 - x) / zoom,
            centerY: (height / 2 - y) / zoom
        };
    }

    function getDisplayImageNodeBounds(node) {
        const width = Number(node?.width) || node?.el?.offsetWidth || FALLBACK_DISPLAY_NODE_WIDTH;
        const height = Number(node?.height) || node?.el?.offsetHeight || FALLBACK_DISPLAY_NODE_HEIGHT;
        const left = Number(node?.x) || 0;
        const top = Number(node?.y) || 0;
        return {
            left,
            top,
            right: left + Math.max(width, 1),
            bottom: top + Math.max(height, 1),
            centerX: left + Math.max(width, 1) / 2,
            centerY: top + Math.max(height, 1) / 2
        };
    }

    function displayImageBoundsIntersect(bounds, viewport, padding = 0) {
        if (!bounds || !viewport) return false;
        return !(
            bounds.right < viewport.left - padding ||
            bounds.left > viewport.right + padding ||
            bounds.bottom < viewport.top - padding ||
            bounds.top > viewport.bottom + padding
        );
    }

    function getDisplayImageNodeDistance(node, viewport) {
        const bounds = getDisplayImageNodeBounds(node);
        const dx = bounds.centerX - viewport.centerX;
        const dy = bounds.centerY - viewport.centerY;
        return dx * dx + dy * dy;
    }

    function getManagedPreviewContainerConfig(node) {
        if (!node?.id) return null;
        if (node.type === 'ImageSave') {
            return {
                containerId: `${node.id}-save-preview`,
                placeholderClass: 'save-preview-placeholder',
                removeSelector: 'img, .image-save-preview-nav, .image-save-preview-counter'
            };
        }
        if (node.type === 'ImagePreview') {
            return {
                containerId: `${node.id}-preview`,
                placeholderClass: 'preview-placeholder',
                removeSelector: 'img, .image-save-preview-nav, .image-save-preview-counter'
            };
        }
        if (node.type === 'ImageResize') {
            return {
                containerId: `${node.id}-resize-preview`,
                placeholderClass: 'preview-placeholder',
                removeSelector: 'img'
            };
        }
        if (isImageImportUploadNode(node)) {
            return {
                containerId: `${node.id}-drop`,
                placeholderClass: 'drop-text',
                removeSelector: 'img'
            };
        }
        if (node.type === 'ImageCompare') {
            return {
                containerId: `${node.id}-compare`,
                placeholderClass: 'preview-placeholder',
                removeSelector: '.image-compare-img, .image-compare-divider'
            };
        }
        return null;
    }

    function getManagedPreviewImageSelector(node) {
        const config = getManagedPreviewContainerConfig(node);
        if (!config) return '';
        if (node.type === 'ImageCompare') return `#${config.containerId} .image-compare-img`;
        return `#${config.containerId} img`;
    }

    function hasHydratedDisplayImages(node) {
        if (!isManagedImageNode(node)) return false;
        if (getManagedNodeImageList(node).length > 0) {
            return true;
        }
        const selector = getManagedPreviewImageSelector(node);
        const img = selector ? node?.el?.querySelector?.(selector) : null;
        return Boolean(img?.getAttribute('src'));
    }

    function hasManagedImageDataInMemory(node) {
        return getManagedNodeImageList(node).length > 0;
    }

    function isDisplayImageNodeProtected(node) {
        if (!node?.id) return true;
        return Boolean(
            state.runningNodeIds?.has(node.id) ||
            state.selectedNodes?.has(node.id) ||
            fullscreenPreviewNodeIds.has(node.id) ||
            node.el?.classList?.contains('running') ||
            node.el?.classList?.contains('is-interacting')
        );
    }

    function shouldReleaseDisplayNodeImages(node, viewport, now = Date.now()) {
        if (!isManagedImageNode(node) || !viewport) return false;
        if (node.data?.imageMemoryReleased === true) return false;
        if (isDisplayImageNodeProtected(node)) return false;
        if (getStoredImageCount(node) <= 0) return false;
        if (!hasHydratedDisplayImages(node)) return false;
        const hydratedAt = Number(node.data?.imageHydratedAt || 0);
        if (hydratedAt > 0 && now - hydratedAt < DISPLAY_IMAGE_RELEASE_GRACE_MS) return false;
        const bounds = getDisplayImageNodeBounds(node);
        return !displayImageBoundsIntersect(bounds, viewport, DISPLAY_IMAGE_RELEASE_PADDING);
    }

    function shouldSoftReleaseDisplayNodeImages(node, now = Date.now()) {
        if (!isManagedImageNode(node)) return false;
        if (node.data?.imageMemoryReleased === true) return false;
        if (isDisplayImageNodeProtected(node)) return false;
        if (!isDisplayImageAssetReady(node)) return false;
        if (!hasManagedImageDataInMemory(node)) return false;
        if (!hasHydratedDisplayImages(node)) return false;
        const hydratedAt = Number(node.data?.imageHydratedAt || 0);
        if (hydratedAt > 0 && now - hydratedAt < DISPLAY_IMAGE_RELEASE_GRACE_MS) return false;
        return true;
    }

    function shouldHydrateDisplayNodeImages(node, viewport) {
        if (!isManagedImageNode(node) || !viewport) return false;
        if (node.data?.imageMemoryReleased !== true) return false;
        if (!getStoredImageAssetKey(node)) return false;
        const bounds = getDisplayImageNodeBounds(node);
        return displayImageBoundsIntersect(bounds, viewport, DISPLAY_IMAGE_HYDRATE_PADDING);
    }

    function markManagedImageAssetReady(node, assetKey = getStoredImageAssetKey(node)) {
        if (!node?.data || !assetKey) return;
        node.data.imageAssetReady = true;
        setAssetState(assetKey, 'ready');
        if (node.id && node.id !== assetKey) setAssetState(node.id, 'ready');
    }

    async function readStoredImages(assetKey) {
        if (!assetKey) return [];
        try {
            let restoredImages = typeof getImageAssetList === 'function'
                ? await getImageAssetList(assetKey)
                : [];
            if (restoredImages.length === 0 && typeof getImageAsset === 'function') {
                const image = await getImageAsset(assetKey);
                if (image) restoredImages = [image];
            }
            return normalizeImageList(restoredImages);
        } catch (error) {
            console.warn('Restore managed image list failed:', error);
            return [];
        }
    }

    async function ensureManagedImageAssetReady(node) {
        const assetKey = getStoredImageAssetKey(node);
        if (!node?.data || !assetKey) return false;
        if (isDisplayImageAssetReady(node)) return true;

        const imageList = getManagedNodeImageList(node);
        if (imageList.length === 0) {
            const existingImages = await readStoredImages(assetKey);
            if (existingImages.length > 0) {
                node.data.imageCount = Math.max(getStoredImageCount(node), existingImages.length);
                markManagedImageAssetReady(node, assetKey);
                return true;
            }
            return false;
        }

        let ok = false;
        try {
            if (imageList.length > 1 && typeof saveImageAssetList === 'function') {
                ok = await saveImageAssetList(assetKey, imageList);
            } else if (isInlineImageData(imageList[0]) && typeof saveImageAsset === 'function') {
                ok = await saveImageAsset(assetKey, imageList[0]);
            }
        } catch (error) {
            console.warn('Save managed image asset before release failed:', error);
            ok = false;
        }
        if (!ok) return false;

        node.data.imageCount = Math.max(getStoredImageCount(node), imageList.length);
        markManagedImageAssetReady(node, assetKey);
        return true;
    }

    function renderReleasedDisplayImagePlaceholder(node) {
        if (!node?.id || !ensureElement || !removeElements || !createPreviewPlaceholder || !updatePreviewPlaceholder) return;
        const config = getManagedPreviewContainerConfig(node);
        if (!config) return;
        const count = getStoredImageCount(node);
        const message = count > 1
            ? `已释放内存，${count} 张图片可点击或移入视野恢复预览`
            : '已释放内存，点击或移入视野恢复预览';
        const container = documentRef.getElementById(config.containerId);
        if (!container) return;
        if (node.type === 'ImageCompare') {
            container.classList.remove('has-images', 'has-a-image', 'is-comparing');
            container.style.setProperty('--compare-x', '50%');
        }
        if (isImageImportUploadNode(node)) {
            container.classList.remove('has-image');
        }
        container.classList.toggle('has-multiple-images', isDisplayImageNode(node) && count > 1);
        removeElements(container, config.removeSelector);
        const placeholder = ensureElement(container, `.${config.placeholderClass}`, () => (
            createPreviewPlaceholder(config.placeholderClass, message, {
                icon: 'cache',
                modifierClass: 'preview-placeholder-memory-released',
                detailText: '原图仍保存在本地缓存中，需要查看时会自动恢复'
            })
        ));
        updatePreviewPlaceholder(placeholder, message, {
            icon: 'cache',
            modifierClass: 'preview-placeholder-memory-released',
            detailText: '原图仍保存在本地缓存中，需要查看时会自动恢复'
        });
        if (isDisplayImageNode(node) && count > 1 && createPreviewNavButton) {
            ensureElement(container, '.image-save-preview-prev', () => createPreviewNavButton(-1));
            ensureElement(container, '.image-save-preview-next', () => createPreviewNavButton(1));
            const counter = ensureElement(container, '.image-save-preview-counter', () => {
                const el = documentRef.createElement('div');
                el.className = 'image-save-preview-counter';
                return el;
            });
            const index = Math.max(0, Math.min(count - 1, Number.isFinite(node.imagePreviewIndex) ? node.imagePreviewIndex : 0));
            counter.textContent = `${index + 1}/${count}`;
        }
        if (node.type === 'ImagePreview') {
            const controls = documentRef.getElementById(`${node.id}-controls`);
            if (controls && count > 0) controls.style.display = 'flex';
        } else if (node.type === 'ImageSave') {
            const manualSaveBtn = documentRef.getElementById(`${node.id}-manual-save`);
            const viewFullBtn = documentRef.getElementById(`${node.id}-view-full`);
            if (manualSaveBtn && count > 0) manualSaveBtn.disabled = false;
            if (viewFullBtn && count > 0) viewFullBtn.disabled = false;
        }
    }

    function clearManagedImageFields(node) {
        if (!node?.data) return;
        delete node.data.image;
        delete node.data.imageList;
        delete node.data.images;
        if (node.type === 'ImageCompare') {
            const hasRecoverableCompareA = state.connections.some((conn) => (
                conn.to?.nodeId === node.id && conn.to?.port === 'imageA'
            ));
            if (hasRecoverableCompareA) {
                delete node.data.compareImageA;
                node.compareImageA = null;
            }
            delete node.data.compareImageB;
            node.compareImageB = null;
        }
        node.imageData = null;
        node.imageDataList = [];
        node.generatedImages = [];
        if (node.type === 'ImageResize') {
            node.resizePreviewData = null;
        }
    }

    async function softReleaseDisplayNodeImages(node) {
        if (!node?.data || !hasManagedImageDataInMemory(node)) return false;
        const count = getStoredImageCount(node);
        if (count <= 0) return false;
        if (!(await ensureManagedImageAssetReady(node))) return false;
        const assetKey = getStoredImageAssetKey(node);
        if (assetKey) {
            if (isImageImportUploadNode(node)) {
                node.imageImportAssetKey = assetKey;
                node.data.imageImportAssetKey = assetKey;
                delete node.data.imageAssetKey;
            } else {
                node.data.imageAssetKey = assetKey;
            }
        }
        node.data.imageCount = count;
        node.data.imageAssetReady = true;
        clearManagedImageFields(node);
        return true;
    }

    async function releaseDisplayNodeImages(node) {
        if (!node?.data) return false;
        const count = getStoredImageCount(node);
        if (count <= 0) return false;
        if (!(await ensureManagedImageAssetReady(node))) return false;
        const assetKey = getStoredImageAssetKey(node);
        if (assetKey && node.type !== 'ImageImport') node.data.imageAssetKey = assetKey;
        node.data.imageCount = count;
        node.data.imageMemoryReleased = true;
        node.data.imageAssetReady = true;
        clearManagedImageFields(node);
        renderReleasedDisplayImagePlaceholder(node);
        return true;
    }

    async function getCompareInputImage(node, portName) {
        if (!node?.id || !portName) return null;
        const incoming = state.connections.find((conn) => conn.to?.nodeId === node.id && conn.to?.port === portName);
        if (!incoming?.from?.nodeId) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        if (!sourceNode || sourceNode.enabled === false) return null;
        const images = await getNodeOutputImageListAsync(sourceNode);
        return normalizeImageList(images)[0] || null;
    }

    async function hydrateReleasedDisplayNodeImages(node) {
        if (!node?.data?.imageMemoryReleased || !getStoredImageAssetKey(node)) return false;
        const images = await restoreStoredImageList(node);
        if (images.length === 0) return false;
        node.data.imageAssetReady = true;
        node.data.imageHydratedAt = Date.now();
        if (node.type === 'ImagePreview' || node.type === 'ImageGenerate') {
            renderImagePreviewImage(node.id, images);
        } else if (node.type === 'ImageSave') {
            renderImageSavePreview(node.id, images);
        } else if (node.type === 'ImageResize') {
            renderImageResizeResult(node.id, {
                ...(node.resizePreviewMeta || {}),
                dataUrl: images[0],
                outputWidth: node.outputWidth || node.resizePreviewMeta?.outputWidth || 0,
                outputHeight: node.outputHeight || node.resizePreviewMeta?.outputHeight || 0,
                outputQuality: node.outputQuality || node.resizePreviewMeta?.outputQuality || null,
                estimatedBytes: node.estimatedBytes || node.resizePreviewMeta?.estimatedBytes || null
            });
        } else if (isImageImportUploadNode(node)) {
            renderImageImportUploadState(node.id, images[0]);
        } else if (node.type === 'ImageCompare') {
            const compareA = await getCompareInputImage(node, 'imageA');
            const compareB = images[0] || null;
            renderImageComparePreview(node.id, compareA, compareB);
        }
        updateResolutionBadgeSoon(node.id, images[node.imagePreviewIndex || 0] || images[0]);
        return true;
    }

    async function sweep(options = {}) {
        const viewport = getDisplayImageViewport();
        const entries = Array.from(state.nodes.values())
            .filter((node) => isManagedImageNode(node))
            .map((node) => ({
                node,
                distance: viewport ? getDisplayImageNodeDistance(node, viewport) : 0
            }))
            .sort((a, b) => a.distance - b.distance);
        let restored = 0;
        let released = 0;
        let softReleased = 0;
        const restoreLimit = Math.max(0, Number(options.restoreLimit ?? DISPLAY_IMAGE_MAX_RESTORE_PER_SWEEP) || 0);
        if (viewport) {
            for (const { node } of entries) {
                if (restored >= restoreLimit) break;
                if (!shouldHydrateDisplayNodeImages(node, viewport)) continue;
                if (await hydrateReleasedDisplayNodeImages(node)) restored += 1;
            }
        }
        const now = Date.now();
        for (const { node } of entries) {
            if (viewport && shouldReleaseDisplayNodeImages(node, viewport, now)) {
                if (await releaseDisplayNodeImages(node)) released += 1;
                continue;
            }
            if (!shouldSoftReleaseDisplayNodeImages(node, now)) continue;
            if (await softReleaseDisplayNodeImages(node)) softReleased += 1;
        }
        return { released, restored, softReleased };
    }

    function scheduleSweep(options = {}) {
        if (displayImageMemorySweepRunning) {
            displayImageMemorySweepQueued = true;
            return;
        }
        const delayMs = Math.max(0, Number(options.delayMs ?? DISPLAY_IMAGE_SWEEP_DELAY_MS) || 0);
        if (displayImageMemorySweepTimer) {
            windowRef.clearTimeout(displayImageMemorySweepTimer);
        }
        displayImageMemorySweepTimer = windowRef.setTimeout(() => {
            displayImageMemorySweepTimer = null;
            displayImageMemorySweepRunning = true;
            displayImageMemorySweepQueued = false;
            sweep(options)
                .catch((error) => console.warn('Display image memory sweep failed:', error))
                .finally(() => {
                    displayImageMemorySweepRunning = false;
                    if (displayImageMemorySweepQueued) {
                        displayImageMemorySweepQueued = false;
                        scheduleSweep();
                    }
                });
        }, delayMs);
    }

    async function getDisplayNodeUpstreamImageList(node) {
        if (!isDisplayImageNode(node)) return [];
        const nodeId = node?.id;
        if (!nodeId) return [];
        const incoming = state.connections.find((conn) => conn.to?.nodeId === nodeId && conn.to?.port === 'image');
        if (!incoming?.from?.nodeId) return [];
        const sourceNode = getNodeById(incoming.from.nodeId);
        if (!sourceNode || sourceNode.enabled === false) return [];
        return getNodeOutputImageListAsync(sourceNode);
    }

    function applyRestoredImagesToNode(node, images, assetKey) {
        const imageList = normalizeImageList(images);
        if (!node?.data || imageList.length === 0) return [];
        const imageCount = Math.max(
            imageList.length,
            Math.max(0, parseInt(node.data?.imageCount || '0', 10) || 0)
        );

        if (node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageGenerate') {
            const currentIndex = node.type === 'ImageGenerate'
                ? imageList.length - 1
                : getImagePreviewIndex(node, imageList);
            setCanonicalImageOutput(node, imageList, {
                currentIndex,
                assetKey,
                imageCount,
                assetReady: true,
                hydratedAt: Date.now()
            });
            if (node.type === 'ImageGenerate') {
                node.generationCompletedCount = imageList.length;
            }
        } else if (node.type === 'ImageResize') {
            const currentImage = imageList[0] || '';
            node.data.image = currentImage;
            node.imageData = currentImage;
            node.imageDataList = imageList.slice();
            node.resizePreviewData = currentImage;
            if (assetKey) node.data.imageAssetKey = assetKey;
            node.data.imageCount = imageCount;
            node.data.imageAssetReady = true;
            node.data.imageHydratedAt = Date.now();
        } else if (isImageImportUploadNode(node)) {
            const currentImage = imageList[0] || '';
            node.imageData = currentImage;
            node.imageDataList = imageList.slice();
            node.data.image = currentImage;
            delete node.data.images;
            if (assetKey) {
                node.imageImportAssetKey = assetKey;
                node.data.imageImportAssetKey = assetKey;
            }
            node.data.imageCount = imageCount;
            node.data.imageAssetReady = true;
            node.data.imageHydratedAt = Date.now();
        } else if (node.type === 'ImageCompare') {
            const currentImage = imageList[0] || '';
            node.data.image = currentImage;
            node.data.compareImageB = currentImage;
            node.imageData = currentImage;
            node.compareImageB = currentImage;
            if (assetKey) node.data.imageAssetKey = assetKey;
            node.data.imageCount = imageCount;
            node.data.imageAssetReady = true;
            node.data.imageHydratedAt = Date.now();
        }

        delete node.data.imageMemoryReleased;
        markManagedImageAssetReady(node, assetKey);
        return imageList;
    }

    async function restoreStoredImageList(node) {
        const inMemoryList = getManagedNodeImageList(node);
        if (inMemoryList.length > 0) {
            return inMemoryList;
        }

        const currentImageList = normalizeImageList(node?.data?.image || node?.imageData || node?.resizePreviewData);
        if (!isManagedImageNode(node)) {
            return currentImageList;
        }

        const assetKey = getStoredImageAssetKey(node);
        if (!assetKey) {
            return currentImageList;
        }

        const restoredImages = await readStoredImages(assetKey);

        if (restoredImages.length > 0) {
            return applyRestoredImagesToNode(node, restoredImages, assetKey);
        }

        const upstreamImages = await getDisplayNodeUpstreamImageList(node);
        if (upstreamImages.length > 0) {
            return applyRestoredImagesToNode(node, upstreamImages, assetKey || node.id);
        }
        return currentImageList;
    }

    function beginFullscreenPreview(nodeId) {
        if (nodeId) fullscreenPreviewNodeIds.add(nodeId);
    }

    function endFullscreenPreview(nodeId) {
        if (!nodeId) return;
        fullscreenPreviewNodeIds.delete(nodeId);
        scheduleSweep({ delayMs: DISPLAY_IMAGE_RELEASE_GRACE_MS });
    }

    return {
        releaseGraceMs: DISPLAY_IMAGE_RELEASE_GRACE_MS,
        maxRestorePerSweep: DISPLAY_IMAGE_MAX_RESTORE_PER_SWEEP,
        isDisplayImageNode,
        isManagedImageNode,
        getStoredImageCount,
        restoreStoredImageList,
        releaseNodeImageData: async (nodeId, options = {}) => {
            const node = getNodeById(nodeId);
            if (!node) return false;
            if (options.force !== true && isDisplayImageNodeProtected(node)) return false;
            return softReleaseDisplayNodeImages(node);
        },
        saveAssetSoon,
        updateResolutionBadgeSoon,
        clearAssetState,
        scheduleSweep,
        sweep,
        beginFullscreenPreview,
        endFullscreenPreview
    };
}
