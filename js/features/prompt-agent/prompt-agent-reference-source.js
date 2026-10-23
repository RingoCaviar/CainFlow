import { latestResultRun } from './prompt-agent-result-order.js';
import { setImageDescription } from '../execution/reference-image-description.js';

export function createPromptAgentReferenceSource({ state, nodeAdapter, getHistoryMetadata, getHistoryEntry, getImageAsset, createImportNode, loadImageData, readWebImage, scheduleSave = () => {} }) {
    const assetKey = node => node?.imageImportAssetKey || node?.data?.imageImportAssetKey || '';
    const reusable = (node, id) => node?.type === 'ImageImport' && node.importMode !== 'url'
        && node.agentReferenceSource?.historyId === String(id)
        && node.agentReferenceSource.assetKey === assetKey(node) && assetKey(node);
    async function listHistory() {
        // History metadata exposes local thumbnail URLs, never hydrated originals.
        const entries = await getHistoryMetadata({ includeThumbs: true, throwOnError: true });
        return entries.filter(item => item.mediaType !== 'video').sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).map(item => ({
            referenceId: `history:${item.id}`, historyId: String(item.id),
            name: item.name || item.title || `历史图片 ${item.id}`, prompt: item.prompt || '',
            timestamp: item.timestamp, thumbAssetKey: item.thumbAssetKey, previewUrl: item.thumb || ''
        }));
    }
    async function readHistory(candidate) {
        const entry = await getHistoryEntry(candidate.historyId);
        if (!entry?.image?.startsWith('data:image/')) throw new Error('历史原图缺失，请重新导入图片。');
        return { name: candidate.name, description: candidate.description || '', dataUrl: entry.image, type: entry.image.slice(5, entry.image.indexOf(';')) };
    }
    async function importReference(candidate, { isCurrent, read, slot = 0, onSourceNode = () => {} } = {}) {
        if (!isCurrent()) return null;
        let node = candidate.nodeId ? state.nodes.get(candidate.nodeId) : null;
        if (!node && candidate.historyId) node = [...state.nodes.values()].find(item => reusable(item, candidate.historyId));
        if (node && reusable(node, candidate.historyId)) {
            onSourceNode(node.id);
            const scene = nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node.id);
            const result = await nodeAdapter.readSceneReferenceImage(scene);
            return isCurrent() ? result : null;
        }
        const image = candidate.resolvedImage || await (candidate.webImage
            ? readWebImage(candidate.webImage.imageUrl).then(dataUrl => ({ name: candidate.name, dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(';')) }))
            : candidate.historyId ? readHistory(candidate) : read());
        if (!isCurrent()) return null;
        candidate.resolvedImage = image;
        if (!image?.dataUrl?.startsWith('data:image/')) throw new Error('无法读取图片。');
        if (!node) {
            const id = createImportNode({ name: image.name || candidate.name, slot });
            if (!id) throw new Error('无法创建图片导入节点。');
            candidate.nodeId = id;
            node = state.nodes.get(id);
            candidate.nodeObject = node;
        } else if (candidate.nodeObject && candidate.nodeObject !== node) {
            throw new Error('图片节点已改变，请移除后重新添加。');
        }
        if (candidate.attempted && assetKey(node) && assetKey(node) !== candidate.savedAssetKey) {
            throw new Error('图片节点已修改，请移除后重新添加。');
        }
        candidate.attempted = true;
        onSourceNode(node.id);
        const saved = await loadImageData(node.id, image.dataUrl);
        if (!isCurrent()) return null;
        if (!saved) throw new Error('图片保存失败，点击重试。');
        if (candidate.description) setImageDescription(node, candidate.description);
        candidate.savedAssetKey = assetKey(node);
        if (candidate.historyId) node.agentReferenceSource = { historyId: String(candidate.historyId), assetKey: assetKey(node),
            ...(candidate.webImage ? { web: { ...candidate.webImage } } : {}) };
        scheduleSave();
        const scene = nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node.id);
        if (!scene) throw new Error('导入节点尚未就绪，请重试。');
        return { ...image, referenceId: scene.referenceId, sourceNodeId: node.id, sourceImageIndex: 0 };
    }
    function getContextReferences(conversation) {
        const latest = latestResultRun(conversation);
        const scene = nodeAdapter.getSceneReferenceImages().filter(item => {
            const node = state.nodes.get(item.sourceNodeId);
            return node && node.enabled !== false && !state.runningNodeIds?.has(node.id);
        }).map(item => ({ ...item, selectedOnCanvas: state.selectedNodes?.has(item.sourceNodeId) || false, contextOrigin: '当前画布素材' }));
        const results = [...(conversation.archivedMessages || []), ...(conversation.messages || [])].flatMap((message, index) =>
            (message.runs || []).flatMap(run => (run.mediaAssetKeys || []).map((key, resultIndex) => ({
                referenceId: `agent-result:${run.runId}:${resultIndex}`, assetKey: key,
                runId: run.runId, resultNumber: resultIndex + 1, messageNumber: index + 1,
                latestResult: run.runId === latest?.runId,
                name: `第 ${index + 1} 条消息生成结果 ${resultIndex + 1}`,
                prompt: message.promptPlan?.prompt || '', contextOrigin: '对话生成结果'
            })))
        );
        return [...scene, ...results];
    }

    async function hydrateLatestResults(references, { isCurrent }) {
        const hydrated = [];
        for (const reference of references) {
            if (!isCurrent()) return null;
            if (!reference.latestResult) { hydrated.push(reference); continue; }
            let dataUrl;
            try { dataUrl = await getImageAsset(reference.assetKey); }
            catch { throw new Error('最新生成结果读取失败，请恢复原图后重试。'); }
            if (!isCurrent()) return null;
            if (!dataUrl?.startsWith('data:image/')) throw new Error('最新生成结果原图缺失，不能改用旧参考图。');
            hydrated.push({ ...reference, dataUrl });
        }
        return hydrated;
    }

    async function preparePlanReferences(plan, { isCurrent, onSourceNode = () => {} }) {
        const references = [];
        for (const reference of plan.referenceImages || []) {
            if (!isCurrent()) return null;
            const scene = nodeAdapter.getSceneReferenceImages().find(item => item.referenceId === reference.referenceId);
            let image;
            if (scene) {
                image = await nodeAdapter.readSceneReferenceImage(scene);
            } else if (reference.runId || (reference.sourceNodeId && state.nodes.get(reference.sourceNodeId)?.type !== 'ImageImport')) {
                // Freeze one result in an ordinary import: never connect a generator
                // to itself, or accidentally send its entire current batch.
                if (reference.sourceNodeId && !state.nodes.has(reference.sourceNodeId)) throw new Error('参考图来源已删除，请重新选择。');
                const key = reference.assetKey || reference.assetKeys?.[reference.sourceImageIndex || 0];
                const candidate = { name: reference.name, ...(key ? { historyId: `agent-asset:${key}` } : {}) };
                const dataUrl = key ? await getImageAsset(key) : reference.dataUrl;
                if (!isCurrent()) return null;
                if (!dataUrl?.startsWith('data:image/')) throw new Error('参考原图缺失，请恢复图片后重试。');
                candidate.resolvedImage = { name: reference.name, dataUrl };
                image = await importReference(candidate, {
                    isCurrent, onSourceNode, slot: references.length,
                    read: async () => candidate.resolvedImage
                });
            } else {
                image = reference;
            }
            if (!isCurrent() || !image) return null;
            references.push({ ...image, role: reference.role, imageId: reference.imageId });
        }
        return references;
    }

    return { listHistory, readHistory, importReference, getContextReferences, hydrateLatestResults, preparePlanReferences,
        getReferenceId: candidate => {
            if (!candidate.historyId) return candidate.referenceId;
            const node = candidate.historyId && [...state.nodes.values()].find(item => reusable(item, candidate.historyId));
            return nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node?.id)?.referenceId || candidate.referenceId;
        },
        loadThumbnail: candidate => candidate.thumbAssetKey ? getImageAsset(candidate.thumbAssetKey) : Promise.resolve('') };
}
