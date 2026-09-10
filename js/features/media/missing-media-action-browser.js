import { createMissingMediaActionCoordinator, validateRecoveryBlob } from './missing-media-actions.js';

function blobToDataUrl(blob, FileReaderRef) {
    return new Promise((resolve, reject) => {
        const reader = new FileReaderRef();
        reader.onerror = () => reject(reader.error || new Error('读取本地媒体失败'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(blob);
    });
}

function chooseFile(documentRef, accept) {
    return new Promise((resolve) => {
        const input = documentRef.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
    });
}

export function createMissingMediaBrowserActions({
    state,
    workflowManager,
    getMediaOwnerReferenceList,
    getStorageSafetyStatus,
    saveWorkflowNodeMediaAsset,
    pushHistory,
    showToast,
    downloadRemoteMedia,
    recoverTaskMedia,
    fetchRef = fetch,
    documentRef = document,
    windowRef = window,
    FileReaderRef = FileReader,
    createImageBitmapRef = createImageBitmap,
    URLRef = URL
}) {
    async function decodeImage(blob) {
        try {
            const bitmap = await createImageBitmapRef(blob);
            bitmap.close();
            return true;
        } catch { return false; }
    }

    async function decodeVideo(blob) {
        return new Promise((resolve) => {
            const video = documentRef.createElement('video');
            const url = URLRef.createObjectURL(blob);
            const finish = (result) => { URLRef.revokeObjectURL(url); video.remove(); resolve(result); };
            video.addEventListener('loadedmetadata', () => finish(video.duration > 0 || Number.isFinite(video.duration)), { once: true });
            video.addEventListener('error', () => finish(false), { once: true });
            video.src = url;
            video.load();
        });
    }

    const validateBlob = (blob, mediaType) => validateRecoveryBlob(blob, mediaType, { decodeImage, decodeVideo });

    async function getContext(workflowId, nodeId) {
        if (workflowManager.getActiveWorkflowId() !== workflowId) return null;
        const node = state.nodes.get(nodeId);
        if (!node) return null;
        const workflow = workflowManager.getActiveWorkflowSnapshot();
        const ownerType = node.type === 'ImageImport' ? 'workflow-import' : 'workflow-node';
        const owner = await getMediaOwnerReferenceList(workflowId, ownerType, nodeId);
        const safety = await getStorageSafetyStatus();
        return {
            workflowId, nodeId, ownerType,
            documentRevision: Number(workflow.mediaOwnershipRevision || 0),
            ownerGeneration: Number(owner?.generation || 0),
            storageEpoch: String(safety?.storageEpoch || ''),
            running: state.runningNodeIds.has(nodeId),
            mediaType: node.data?.mediaIntegrity?.mediaType || 'image',
            assetKeys: Array.isArray(node.data?.mediaAssetKeys) ? node.data.mediaAssetKeys.slice() : []
        };
    }

    async function materialize(request, value) {
        const asset = await saveWorkflowNodeMediaAsset(value, request.workflowId, request.nodeId, request.operationId);
        if (!asset?.asset_key) throw new Error('媒体内容持久化失败');
        return { ...asset, assetKey: asset.asset_key, mediaType: request.mediaType || 'image' };
    }

    const coordinator = createMissingMediaActionCoordinator({
        confirm: async (request) => windowRef.confirm(
            request.kind === 'remove' ? '确认移除选中的媒体引用？此操作可撤销。' : '确认执行所选媒体恢复操作？'
        ),
        getContext,
        recordUndo: () => pushHistory(),
        recoverRemote: async (request) => {
            const blob = downloadRemoteMedia
                ? await downloadRemoteMedia(request.source.url, request.mediaType || 'image', request.signal)
                : await (async () => {
                    const response = await fetchRef('/api/media/download', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: request.source.url }), signal: request.signal
                    });
                    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '远程媒体下载失败');
                    return response.blob();
                })();
            await validateBlob(blob, request.mediaType || 'image');
            return materialize(request, await blobToDataUrl(blob, FileReaderRef));
        },
        recoverTask: async (request) => {
            if (!recoverTaskMedia) throw new Error('当前任务类型不支持按 identity 恢复');
            const value = await recoverTaskMedia(request.nodeId, request.mediaType || 'image', request.signal);
            const blob = value instanceof Blob ? value : null;
            if (blob) await validateBlob(blob, request.mediaType || 'image');
            return materialize(request, blob ? await blobToDataUrl(blob, FileReaderRef) : value);
        },
        recoverLocal: async (request) => materialize(
            request, await blobToDataUrl(await validateBlob(request.localFile, request.mediaType || 'image'), FileReaderRef)
        ),
        materializeReplacement: async (request) => materialize(
            request, await blobToDataUrl(await validateBlob(request.localFile, request.mediaType || 'image'), FileReaderRef)
        ),
        commitReferenceList: async (request) => {
            const node = state.nodes.get(request.nodeId);
            if (!node) throw new Error('媒体节点已关闭');
            const previousKeys = node.data.mediaAssetKeys.slice();
            const previousIntegrity = node.data.mediaIntegrity;
            const previousTemporaryOwners = node.data.mediaOwnershipTemporaryOwners;
            workflowManager.expectNextMediaOwnerGeneration({
                workflowId: request.workflowId, ownerType: request.ownerType, ownerId: request.nodeId,
                generation: request.expectedOwnerGeneration, documentRevision: request.expectedDocumentRevision
                , storageEpoch: request.expectedStorageEpoch
            });
            node.data.mediaAssetKeys = request.assetKeys.slice();
            if (request.materializedAsset?.mediaTemporaryOwnerId) {
                node.data.mediaOwnershipTemporaryOwners = [...(previousTemporaryOwners || []), {
                    ownerId: request.materializedAsset.mediaTemporaryOwnerId,
                    assetKeys: [request.materializedAsset.assetKey]
                }].filter((candidate, index, owners) => owners.findIndex((item) => item.ownerId === candidate.ownerId) === index);
            }
            const removedPositions = new Set(request.intent === 'remove' ? (request.positions || []) : [request.position]);
            const remainingMissing = (previousIntegrity?.missingItems || []).flatMap((missing) => {
                if (removedPositions.has(missing.position)) return [];
                const shift = request.intent === 'remove'
                    ? (request.positions || []).filter((position) => position < missing.position).length : 0;
                return [{ ...missing, position: missing.position - shift }];
            });
            if (request.intent === 'undo' && request.restoredMissing?.length) {
                node.data.mediaIntegrity = {
                    state: 'missing', mediaType: previousIntegrity?.mediaType || 'image', ownerType: request.ownerType,
                    itemCount: request.assetKeys.length,
                    missingItems: request.restoredMissing.map((missing) => ({
                        ...missing, workflowId: request.workflowId, nodeId: request.nodeId,
                        ownerType: request.ownerType, ownerId: `${request.workflowId}:${request.nodeId}`,
                        mediaType: previousIntegrity?.mediaType || 'image', redactedSource: String(missing.assetKey).slice(0, 18)
                    }))
                };
            } else if (remainingMissing.length > 0) {
                node.data.mediaIntegrity = { ...previousIntegrity, itemCount: request.assetKeys.length, missingItems: remainingMissing };
            } else delete node.data.mediaIntegrity;
            if (!await workflowManager.saveActiveWorkflow({ silent: true })) {
                workflowManager.clearExpectedMediaOwnerGeneration({ ...request, ownerId: request.nodeId });
                node.data.mediaAssetKeys = previousKeys;
                if (previousIntegrity) node.data.mediaIntegrity = previousIntegrity;
                if (previousTemporaryOwners) node.data.mediaOwnershipTemporaryOwners = previousTemporaryOwners;
                else delete node.data.mediaOwnershipTemporaryOwners;
                throw new Error('工作流版本已变化，媒体操作未提交');
            }
            return {
                status: 'committed',
                documentRevision: Number(workflowManager.getActiveWorkflowSnapshot().mediaOwnershipRevision || 0)
            };
        }
    });

    return async function handle({ action, item, node, positions = [] }) {
        try {
            const workflowId = workflowManager.getActiveWorkflowId();
            const context = await getContext(workflowId, node.id);
            if (!context) throw new Error('媒体节点已关闭');
            let localFile = null;
            if (action === 'local-recover' || action === 'replace') {
                localFile = await chooseFile(documentRef, context.mediaType === 'video' ? 'video/*' : 'image/*');
                if (!localFile) return;
            }
            const sourceUrl = node.data?.imageTaskUrl || node.data?.videoUrl || node.data?.video?.url || '';
            const result = await coordinator.run({
                kind: action === 'remove-selected' ? 'remove' : action,
                workflowId, nodeId: node.id, position: item?.position,
                positions: action === 'remove' ? [item.position] : (action === 'remove-selected' ? positions : undefined),
                expectedAssetKey: item?.assetKey,
                expectedDocumentRevision: context.documentRevision, expectedOwnerGeneration: context.ownerGeneration,
                expectedStorageEpoch: context.storageEpoch,
                ownerType: context.ownerType, mediaType: context.mediaType,
                source: { url: sourceUrl, taskId: node.data?.imageTaskId || '', persisted: true }, localFile
            });
            if (result.status === 'committed') showToast('媒体操作已提交', 'success');
        } catch (error) {
            showToast(error?.message || '媒体操作失败，原引用已保留', 'error');
        }
    };
}
