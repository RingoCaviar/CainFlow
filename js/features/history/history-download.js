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
 * 发起一条历史媒体的浏览器下载。
 * 浏览器无法报告文件是否最终落盘，返回值只表示下载请求是否已成功发起。
 */
export function startHistoryDownload(entry, { downloadImage, documentRef, windowRef } = {}) {
    try {
        if (entry?.mediaType === 'video' || entry?.hasVideo || entry?.videoBlob instanceof Blob) {
            const blob = entry.videoBlob || entry.video;
            if (downloadBlob(blob, `cainflow_${entry.id}${getVideoExtension(entry, blob)}`, documentRef || globalThis.document, windowRef || globalThis.window)) return true;
            return !!entry.videoUrl && !!windowRef.open(entry.videoUrl, '_blank', 'noopener,noreferrer');
        }
        return !!entry?.image && downloadImage(entry.image, `cainflow_${entry.id}.png`) !== false;
    } catch (error) {
        return false;
    }
}
