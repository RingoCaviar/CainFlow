export function createPromptAgentReferenceSource({ state, nodeAdapter, getHistoryMetadata, getHistoryEntry, getImageAsset, createImportNode, loadImageData, scheduleSave = () => {} }) {
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
        return { name: candidate.name, dataUrl: entry.image, type: entry.image.slice(5, entry.image.indexOf(';')) };
    }
    async function importReference(candidate, { isCurrent, read, slot = 0 } = {}) {
        if (!isCurrent()) return null;
        let node = candidate.nodeId ? state.nodes.get(candidate.nodeId) : null;
        if (!node && candidate.historyId) node = [...state.nodes.values()].find(item => reusable(item, candidate.historyId));
        if (node && reusable(node, candidate.historyId)) {
            const scene = nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node.id);
            const result = await nodeAdapter.readSceneReferenceImage(scene);
            return isCurrent() ? result : null;
        }
        const image = candidate.resolvedImage || await (candidate.historyId ? readHistory(candidate) : read());
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
        const saved = await loadImageData(node.id, image.dataUrl);
        if (!isCurrent()) return null;
        if (!saved) throw new Error('图片保存失败，点击重试。');
        candidate.savedAssetKey = assetKey(node);
        if (candidate.historyId) node.agentReferenceSource = { historyId: String(candidate.historyId), assetKey: assetKey(node) };
        scheduleSave();
        const scene = nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node.id);
        if (!scene) throw new Error('导入节点尚未就绪，请重试。');
        return { ...image, referenceId: scene.referenceId, sourceNodeId: node.id, sourceImageIndex: 0 };
    }
    return { listHistory, readHistory, importReference,
        getReferenceId: candidate => {
            if (!candidate.historyId) return candidate.referenceId;
            const node = candidate.historyId && [...state.nodes.values()].find(item => reusable(item, candidate.historyId));
            return nodeAdapter.getSceneReferenceImages().find(item => item.sourceNodeId === node?.id)?.referenceId || candidate.referenceId;
        },
        loadThumbnail: candidate => candidate.thumbAssetKey ? getImageAsset(candidate.thumbAssetKey) : Promise.resolve('') };
}
