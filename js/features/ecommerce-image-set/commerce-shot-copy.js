export function getCommerceShotCopy(shot) {
    if (typeof shot?.copy === 'string') return shot.copy;
    const headline = typeof shot?.headline === 'string' && shot.headline;
    const body = typeof shot?.body === 'string' && shot.body;
    return [headline && `标题：${headline}`, body && `正文：${body}`].filter(Boolean).join('\n\n');
}
