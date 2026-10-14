export function buildCanvasMaterializationPlan({
    workflowId,
    messageId,
    textNodeType = 'Text',
    text = '',
    media = [],
    origin = { x: 0, y: 0 }
}) {
    if (!workflowId) throw new Error('Target Workflow identity is required');
    if (!['Text', 'TextChat'].includes(textNodeType)) throw new Error('Unsupported text node type');
    const nodes = [];
    if (String(text).trim()) {
        nodes.push({
            type: textNodeType,
            x: origin.x,
            y: origin.y,
            restoreData: { text: String(text), conversationSourceMessageId: messageId }
        });
    }
    media.forEach((item, index) => {
        if (item.missing) throw new Error(`Media asset is missing: ${item.assetKey}`);
        if (item.mediaType !== 'image') throw new Error(`Unsupported canvas media type: ${item.mediaType}`);
        nodes.push({
            type: 'ImagePreview',
            x: origin.x + (nodes.length ? 280 : 0) + index * 28,
            y: origin.y + index * 28,
            restoreData: {
                mediaAssetKeys: [item.assetKey],
                imageAssetKey: item.assetKey,
                conversationSourceMessageId: messageId
            }
        });
    });
    if (!nodes.length) throw new Error('Assistant message has no materializable content');
    return { workflowId, messageId, origin: { ...origin }, nodes };
}

export function createCanvasMaterializationCommand({
    addNode,
    removeNode,
    pushHistory,
    discardHistory = () => {},
    selectNode = () => {},
    switchToCanvas = () => {},
    focusNode = () => {},
    save = () => {}
}) {
    async function apply(plan, { confirmed = false } = {}) {
        if (!confirmed) return { status: 'cancelled', nodeIds: [] };
        const undoToken = pushHistory();
        const nodeIds = [];
        try {
            for (const node of plan.nodes) {
                const nodeId = addNode(node.type, node.x, node.y, node.restoreData, true);
                if (!nodeId) throw new Error(`Unable to create ${node.type} node`);
                nodeIds.push(nodeId);
            }
            nodeIds.forEach((nodeId, index) => selectNode(nodeId, index > 0));
            const saved = await save();
            if (saved === false || saved?.committed === false) throw new Error('Unable to save materialized nodes');
            switchToCanvas();
            focusNode(nodeIds[0]);
            return { status: 'applied', nodeIds, undoToken };
        } catch (error) {
            for (const nodeId of [...nodeIds].reverse()) removeNode(nodeId, { silent: true });
            discardHistory(undoToken);
            throw error;
        }
    }
    return { apply };
}
