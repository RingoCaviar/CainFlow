const isImagePort = port => port === 'image' || port === 'referenceImages' || /^image_\d+$/.test(port);

export function getImageDescription(node) {
    return String(node?.data?.imageDescription || '').trim().slice(0, 2000);
}

export function setImageDescription(node, description) {
    if (!node) return '';
    const value = String(description || '').trim().slice(0, 2000);
    node.data ||= {};
    node.data.imageDescription = value;
    return value;
}

export function appendReferenceDescriptions(prompt, state, targetNodeId) {
    const connections = (state?.connections || [])
        .filter(link => link?.to?.nodeId === targetNodeId && isImagePort(link.to.port))
        .map((link, index) => ({ link, index }))
        .sort((a, b) => {
            const rank = entry => entry.link.to.port === 'image' ? 0
                : entry.link.to.port === 'referenceImages' ? 100 + (entry.link.order ?? entry.index)
                : Number(entry.link.to.port.slice(6)) || 0;
            return rank(a) - rank(b) || a.index - b.index;
        });
    const descriptions = connections.map(({ link }, index) => {
        const description = getImageDescription(state.nodes?.get(link.from?.nodeId));
        return description ? `参考图 ${index + 1}：${description}` : '';
    }).filter(Boolean);
    return descriptions.length ? `${String(prompt || '').trim()}\n\n${descriptions.join('\n')}` : prompt;
}
