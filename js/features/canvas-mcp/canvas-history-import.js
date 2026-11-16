import { normalizeCanvasPlan } from '../prompt-agent/prompt-agent-canvas-plan.js';

const versionPattern = /^[0-9]{1,20}:-?[0-9]{1,20}$/;

export function createHistoryCanvasImporter({
    canvasAdapter, listHistoryImages, getHistoryImageBlob,
    saveWorkflowNodeMediaAsset, cancelWorkflowNodeMediaOperation, persist
}) {
    return async function importHistory({ items } = {}, { context = canvasAdapter.context(), isCurrent = () => true } = {}) {
        if (!Array.isArray(items) || items.length < 1 || items.length > 20
            || items.some(item => !item || typeof item !== 'object' || Array.isArray(item)
                || Object.keys(item).some(key => key !== 'id' && key !== 'fileVersion')
                || !Number.isSafeInteger(item.id) || item.id === 0
                || typeof item.fileVersion !== 'string' || !versionPattern.test(item.fileVersion))
            || new Set(items.map(item => item.id)).size !== items.length) {
            throw new Error('历史图片参数无效，请使用 1 至 20 个不同的图片 ID 和读取时的版本。');
        }
        const { workflowId } = context;
        if (!workflowId) throw new Error('请先打开要导入历史图片的工作流。');
        const ensureCurrent = () => {
            if (!isCurrent() || canvasAdapter.context().workflowId !== workflowId) {
                throw new Error('操作范围已变化，请重新选择要导入的历史图片。');
            }
        };
        const stagedImports = new Map();
        const attemptedOwners = [];
        let workflowCommitted = false;
        let publicationUnknown = false;
        let ownershipPending = false;
        try {
            const sources = [];
            for (const { id, fileVersion } of items) {
                ensureCurrent();
                const { items: current } = await listHistoryImages({ id, limit: 1 });
                const image = current.find(item => item.id === id);
                if (!image || image.fileVersion !== fileVersion) {
                    throw new Error('历史图片已变化或离开当前保存目录，请刷新历史后重新选择。');
                }
                sources.push(image);
            }
            for (const image of sources) {
                ensureCurrent();
                const blob = await getHistoryImageBlob(image.id, { fileVersion: image.fileVersion });
                if (!blob?.size) throw new Error('无法读取选定的历史原图，请刷新历史后重试。');
                ensureCurrent();
                const nodeId = 'node_' + crypto.randomUUID();
                const operationId = crypto.randomUUID();
                attemptedOwners.push({ nodeId, operationId });
                const asset = await saveWorkflowNodeMediaAsset(blob, workflowId, nodeId, operationId, { isCurrent }).catch(() => null);
                ensureCurrent();
                if (!asset?.asset_key?.startsWith('media:') || !asset.mediaTemporaryOwnerId) {
                    throw new Error('保存历史原图失败，请检查 CainFlow 存储后重试。');
                }
                const stepId = 'history_' + operationId;
                const title = image.note || image.filename || '历史图片 ' + image.id;
                stagedImports.set(stepId, { nodeId, asset, title, id: image.id, fileVersion: image.fileVersion });
            }
            ensureCurrent();
            const plan = normalizeCanvasPlan({
                version: 1,
                steps: [...stagedImports].map(([id, item]) => ({
                    id, type: 'ImageImport', title: item.title, assetKey: item.asset.asset_key, parameters: {}, execute: false
                }))
            }, context, {
                images: [...stagedImports.values()].map(item => ({ reference: { assetKey: item.asset.asset_key } }))
            });
            try {
                const result = await canvasAdapter.apply(plan, '', undefined, isCurrent, {
                    stagedImports,
                    persist: async () => {
                        const saved = await persist();
                        workflowCommitted = saved?.committed === true || saved === true;
                        publicationUnknown = saved?.publicationUnknown === true;
                        ownershipPending = saved?.ownershipPending === true;
                        if (publicationUnknown) throw new Error('无法确认导入保存结果，请重新打开工作流查看后再重试。');
                        return saved;
                    }
                });
                return {
                    workflowId,
                    imported: [...stagedImports].map(([stepId, item]) => ({
                        id: item.id, fileVersion: item.fileVersion, nodeId: result.bindings[stepId]
                    })),
                    ...(ownershipPending ? { ownershipPending: true } : {})
                };
            } finally {
                canvasAdapter.discardExecutionConfig?.(plan);
            }
        } finally {
            if (!workflowCommitted && !publicationUnknown) {
                await Promise.allSettled(attemptedOwners.map(({ nodeId, operationId }) =>
                    cancelWorkflowNodeMediaOperation(workflowId, nodeId, operationId)));
            }
        }
    };
}
