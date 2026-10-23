import { getCanonicalImageList } from './execution-data-utils.js';

const isImagePort = port => port === 'image' || port === 'referenceImages' || /^image_\d+$/.test(port);

export function getImageDescription(node, index = 0) {
    const description = index === 0
        ? (node?.data?.imageDescription || node?.data?.imageDescriptions?.[0])
        : node?.data?.imageDescriptions?.[index];
    return String(description || '').trim().slice(0, 2000);
}

export function setImageDescription(node, description, index = 0) {
    if (!node) return '';
    const value = String(description || '').trim().slice(0, 2000);
    node.data ||= {};
    if (index === 0) {
        node.data.imageDescription = value;
        if (Array.isArray(node.data.imageDescriptions)) node.data.imageDescriptions[0] = value;
    }
    else {
        node.data.imageDescriptions ||= [];
        node.data.imageDescriptions[index] = value;
    }
    return value;
}

export function appendReferenceDescriptions(prompt, state, targetNodeId, inputConnections = state?.connections || []) {
    const connections = inputConnections
        .filter(link => link?.to?.nodeId === targetNodeId && isImagePort(link.to.port))
        .map((link, index) => ({ link, index }))
        .sort((a, b) => {
            const rank = entry => entry.link.to.port === 'image' ? 0
                : entry.link.to.port === 'referenceImages' ? 100 + (entry.link.order ?? entry.index)
                : Number(entry.link.to.port.slice(6)) || 0;
            return rank(a) - rank(b) || a.index - b.index;
        });
    let imageNumber = 0;
    const descriptions = connections.flatMap(({ link }) => {
        const source = state.nodes?.get(link.from?.nodeId);
        const availableCount = Math.max(getCanonicalImageList(source).length, source?.data?.mediaAssetKeys?.length || 0);
        const count = link.to.port === 'referenceImages' ? Math.max(1, availableCount || source?.data?.imageCount || 0) : 1;
        return Array.from({ length: count }, (_, index) => {
            const description = getImageDescription(source, index);
            imageNumber += 1;
            return description ? `参考图 ${imageNumber}：${description}` : '';
        }).filter(Boolean);
    });
    return descriptions.length ? `${String(prompt || '').trim()}\n\n${descriptions.join('\n')}` : prompt;
}
