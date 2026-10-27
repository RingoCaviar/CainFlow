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


// Permission is conservative and scoped to the explicitly edited generation target.
// Ambiguous partial/negative instructions cannot authorize clearing an entire input.
export function requestsReferenceRemoval(message = '') {
    const text = String(message).replace(/@[^@\[\]\r\n]+\[[^\]\r\n]+\]\s*/g, '');
    const clauses = text.split(/[。！？；;\n，,]/).map(value => value.trim());
    if (/(?:参考图?\s*(?:第|[0-9一二三四五六七八九十])|第\s*[0-9一二三四五六七八九十]+\s*张)/.test(text)) return false;
    if (clauses.some(clause => /(?:保留|保持|沿用|keep|retain|preserve)[^。！？]{0,30}(?:参考|reference)|(?:参考|reference)[^。！？]{0,30}(?:保留|保持|不变|原样|不动)/i.test(clause))) return false;
    const clearWithout = clause => /^(?:(?:但是|但|请|本轮|这次|现在)\s*)*(?:不要|不用|无需|不需要|不使用|不再使用)\s*(?:任何)?参考图(?:了|吧|啦)?(?:$|\s)/.test(clause)
        || /^without (?:any )?reference images?$/i.test(clause);
    if (clauses.some(clause => /(?:不要|别|不能|不许|不得|无需|不必|禁止|do not|don't|must not)/i.test(clause) && !clearWithout(clause))) return false;
    return clauses.some(clause => clearWithout(clause) || /纯(?:文字|文本|文)生图/.test(clause)
        || /(?:断开|移除|删除|清空|去掉|替换|更换|换掉)\s*(?:(?:当前|原有|已有|所有|全部|现有|这些|旧的)\s*)*参考(?:图|关系)(?![0-9一二三四五六七八九十])/.test(clause)
        || /参考(?:图|关系)\s*(?:都|全部|全都|整体)?\s*(?:断开|移除|删除|清空|去掉|替换|更换|换成)/.test(clause)
        || /(?:remove|disconnect|replace|clear)\s+(?:the\s+|all\s+|existing\s+|current\s+)*(?:references?|reference images?)(?!\s*\d)/i.test(clause));
}

export function referenceInputChangePermission(message, targetNodeIds) {
    const targets = [...new Set(targetNodeIds.filter(Boolean))];
    if (targets.length !== 1 || !requestsReferenceRemoval(message)) return null;
    const replace = /(?:替换|更换|换掉)\s*(?:(?:当前|原有|已有|所有|全部|现有|这些|旧的)\s*)*参考(?:图|关系)|参考(?:图|关系)\s*(?:全部|整体)?\s*(?:替换|更换|换成)|replace\s+(?:the\s+|all\s+|existing\s+|current\s+)*(?:references?|reference images?)/i.test(message);
    return { mode: replace && !excludesReferenceImages(message, null) ? 'replace' : 'clear', targetNodeIds: targets };
}
