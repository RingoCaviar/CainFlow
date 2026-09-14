import { normalizeImageList } from '../execution/execution-data-utils.js';

function getVideos(payload = {}) {
    return (Array.isArray(payload?.videos) ? payload.videos : [payload?.video])
        .filter((video) => video && typeof video === 'object' && typeof video.url === 'string' && video.url.trim());
}

/**
 * Saves the complete ordered ImageSave payload to a user-selected directory.
 * Callers provide UI and platform adapters; this module owns no DOM or node state.
 */
export async function saveGeneratedMediaToDirectory({
    payload,
    directoryHandle,
    filenamePrefix,
    dataURLtoBlob,
    downloadVideo,
    buildImageFilenameBases,
    buildVideoFilenameBase,
    detectVideoExtension,
    getAvailableFileHandle,
    onVideoProgress = () => {}
} = {}) {
    const images = normalizeImageList(payload?.images ?? payload);
    const videos = getVideos(payload);
    if (images.length === 0 && videos.length === 0) return { status: 'empty', filenames: [] };
    if (!directoryHandle) return { status: 'missing-directory', filenames: [] };

    let permission = await directoryHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') permission = await directoryHandle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return { status: 'permission-denied', filenames: [] };

    const filenames = [];
    const imageBases = buildImageFilenameBases(images, filenamePrefix);
    for (let index = 0; index < images.length; index += 1) {
        const blob = dataURLtoBlob(images[index]);
        if (!blob) throw new Error('图片数据无效，无法写入文件');
        const { fileHandle, filename } = await getAvailableFileHandle(directoryHandle, imageBases[index], '.png');
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        filenames.push(filename);
    }

    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        onVideoProgress({ index, videoCount: videos.length, stage: 'downloading' });
        const blob = await downloadVideo(video.url, {
            onProgress: (progress) => onVideoProgress({ index, videoCount: videos.length, stage: progress?.done ? 'writing' : 'downloading', ...progress })
        });
        const baseName = buildVideoFilenameBase(video, filenamePrefix);
        const { fileHandle, filename } = await getAvailableFileHandle(
            directoryHandle, baseName, detectVideoExtension(video, blob)
        );
        onVideoProgress({ index, videoCount: videos.length, stage: 'writing', loaded: blob.size || 0, total: blob.size || 0 });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        filenames.push(filename);
        onVideoProgress({ index, videoCount: videos.length, stage: 'complete', filename });
    }
    return { status: 'saved', filenames };
}
