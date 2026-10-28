import { projectImageReferences } from '../../nodes/image-reference-projection.js';

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
    const { slots } = projectImageReferences({ state, targetId: targetNodeId, connections: inputConnections });
    const descriptions = slots.map(slot => {
        const description = getImageDescription(slot.source, slot.index);
        return description ? `参考图 ${slot.number}：${description}` : '';
    }).filter(Boolean);
    return descriptions.length ? `${String(prompt || '').trim()}\n\n${descriptions.join('\n')}` : prompt;
}
