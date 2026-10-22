// Candidate visibility is not permission to materialize a reference node.
export function excludesReferenceImages(message, selection) {
    return selection?.mode === 'none' || /(?:不(?:要|用|使用|需要)|无需|不用任何)\s*(?:任何)?参考图|纯(?:文字|文本|文)生图|without (?:any )?reference images?/i.test(message);
}

export function mayUseCandidate(image, { message = '', selection, evidence = '', intent } = {}) {
    if (excludesReferenceImages(message, selection)) return false;
    if (intent === 'edit') return true; // The latest/explicit target gate runs separately.
    if (image?.origins?.includes('本轮附件')) return true;
    const quote = evidence || (selection?.mode === 'explicit' && selection.imageId === image?.imageId ? selection.evidence : '');
    return typeof quote === 'string' && Boolean(quote.trim()) && message.includes(quote.trim());
}
