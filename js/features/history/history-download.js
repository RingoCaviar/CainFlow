function getVideoExtension(entry, blob) {
    const mime = String(entry?.videoMimeType || blob?.type || '').toLowerCase();
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
    if (mime.includes('x-matroska') || mime.includes('mkv')) return '.mkv';
    return '.mp4';
}

function downloadBlob(blob, filename, documentRef, windowRef) {
    if (!(blob instanceof Blob)) return false;
    const url = URL.createObjectURL(blob);
    try {
        const link = documentRef.createElement('a');
        link.href = url;
        link.download = filename;
        documentRef.body.appendChild(link);
        link.click();
        documentRef.body.removeChild(link);
        windowRef.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    } catch (error) {
        URL.revokeObjectURL(url);
        return false;
    }
}

/**
 * 保存一条历史媒体。桌面端等待原生保存结果；浏览器端只能确认下载请求已发起。
 */
export async function startHistoryDownload(entry, { downloadImage, documentRef, windowRef } = {}) {
    try {
        const desktop = windowRef?.__cainflowDesktop;
        if (entry?.mediaType === 'video' || entry?.hasVideo || entry?.videoBlob instanceof Blob) {
            const blob = entry.videoBlob || entry.video;
            if (desktop?.saveFile) {
                const source = blob instanceof Blob ? blob : entry.videoUrl;
                if (!source) return false;
                return Boolean(await desktop.saveFile(`cainflow_${entry.id}${getVideoExtension(entry, blob)}`, blob?.type || 'video/mp4', source));
            }
            if (downloadBlob(blob, `cainflow_${entry.id}${getVideoExtension(entry, blob)}`, documentRef || globalThis.document, windowRef || globalThis.window)) return true;
            return !!entry.videoUrl && !!windowRef.open(entry.videoUrl, '_blank', 'noopener,noreferrer');
        }
        if (desktop?.saveFile) {
            return Boolean(entry?.image && await desktop.saveFile(`cainflow_${entry.id}.png`, 'image/png', entry.image));
        }
        return !!entry?.image && downloadImage(entry.image, `cainflow_${entry.id}.png`) !== false;
    } catch (error) {
        return false;
    }
}
