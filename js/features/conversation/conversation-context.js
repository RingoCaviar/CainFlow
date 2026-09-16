function cloneItem(item) {
    return JSON.parse(JSON.stringify(item));
}

export function snapshotWorkflowNode({ workflowId, node }) {
    if (!workflowId || !node?.id || !node?.type) throw new Error('Workflow identity and node are required');
    const data = node.data || {};
    const mediaAssetKeys = Array.isArray(data.mediaAssetKeys)
        ? data.mediaAssetKeys
        : [data.imageAssetKey, data.imageImportAssetKey, data.videoAssetKey].filter(Boolean);
    return Object.freeze({
        type: 'node-source',
        workflowId,
        nodeId: node.id,
        nodeType: node.type,
        textSnapshot: String(data.text || data.prompt || ''),
        mediaAssetKeys: Object.freeze([...mediaAssetKeys])
    });
}

export function createStagedConversationContext(initialItems = []) {
    let items = initialItems.map(cloneItem);

    function add(item) {
        if (!item?.id || !item?.type) throw new Error('Staged context item identity and type are required');
        if (items.some((current) => current.id === item.id)) return false;
        items.push(cloneItem(item));
        return true;
    }

    function remove(itemId) {
        const previousLength = items.length;
        items = items.filter((item) => item.id !== itemId);
        return items.length !== previousLength;
    }

    function move(itemId, targetIndex) {
        const index = items.findIndex((item) => item.id === itemId);
        if (index < 0) return false;
        const [item] = items.splice(index, 1);
        items.splice(Math.max(0, Math.min(items.length, targetIndex)), 0, item);
        return true;
    }

    function list() {
        return items.map(cloneItem);
    }

    function clear() {
        items = [];
    }

    function toMessageParts() {
        return items.map((item) => {
            if (item.type === 'node-source') return cloneItem(item.snapshot || item);
            return {
                type: 'media',
                assetKey: item.assetKey,
                mediaType: item.mediaType || 'image',
                ...(item.url ? { url: item.url } : {})
            };
        });
    }

    return { add, remove, move, list, clear, toMessageParts };
}
