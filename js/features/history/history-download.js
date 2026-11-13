import { createZipBlob } from '../../core/zip-archive.js';
import { getImageExtension } from '../media/preview-image-download.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

let batchDownloading = false;

function isVideoEntry(entry) {
    return entry?.mediaType === 'video' || entry?.hasVideo || entry?.videoBlob instanceof Blob;
}

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
        if (isVideoEntry(entry)) {
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

function getBatchFile(entry, id) {
    const video = isVideoEntry(entry);
    const blob = entry?.videoBlob || entry?.video;
    const source = video ? (blob instanceof Blob ? blob : entry.videoUrl) : entry?.image;
    if (!source) throw new Error('历史原文件无法读取');

    const extension = /\.[a-z0-9]+$/i.exec(entry.relativePath || '')?.[0]
        || (video ? getVideoExtension(entry, blob) : getImageExtension(source) || '.png');
    const base = 'cainflow_' + String(id).replace(/[^a-z0-9_-]/gi, '_');
    return { name: base + extension, source };
}

async function readDownloadBlob(source) {
    if (source instanceof Blob) return source;
    const response = await fetch(source);
    if (!response.ok) throw new Error('历史原文件无法读取');
    return response.blob();
}

async function saveToBrowserDirectory(directory, name, source) {
    const blob = await readDownloadBlob(source);
    const extension = /\.[^.]+$/.exec(name)[0];
    const base = name.slice(0, -extension.length);
    for (let index = 0; index < 1000; index += 1) {
        const filename = index === 0 ? name : base + '_' + (index + 1) + extension;
        try {
            await directory.getFileHandle(filename);
        } catch (error) {
            if (error.name === 'TypeMismatchError') continue;
            if (error.name !== 'NotFoundError') throw error;
            const handle = await directory.getFileHandle(filename, { create: true });
            let writable;
            try {
                writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } catch (writeError) {
                await writable?.abort().catch(() => {});
                try {
                    if ((await handle.getFile()).size === 0) await directory.removeEntry(filename);
                } catch {
                    // Best effort if the browser revoked directory access.
                }
                throw writeError;
            }
            return;
        }
    }
    throw new Error('无法生成不重复的文件名');
}

function openDownloadProgress(total, archive, documentRef) {
    const dialog = documentRef.createElement('dialog');
    dialog.className = 'history-download-progress';
    dialog.setAttribute('aria-label', '批量下载');
    dialog.innerHTML = '<h3></h3><p role="status" aria-live="polite"></p><progress aria-label="下载进度"></progress><p></p><button type="button" disabled>完成</button>';
    const title = dialog.querySelector('h3');
    const [count, result] = dialog.querySelectorAll('p');
    const progress = dialog.querySelector('progress');
    const button = dialog.querySelector('button');
    const dismiss = () => { dialog.close(); dialog.remove(); };
    const dismissWhenFinished = () => { if (!button.disabled) dismiss(); };

    title.textContent = archive ? '正在准备下载压缩包' : '正在保存历史记录';
    progress.max = total;
    getSurfaceCoordinator(documentRef)?.registerEscape(dialog, dismissWhenFinished);
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
    });
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        dismissWhenFinished();
    });
    button.addEventListener('click', dismiss);
    documentRef.body.append(dialog);
    try {
        dialog.showModal();
    } catch (error) {
        dialog.remove();
        throw error;
    }

    return {
        update(completed, failed) {
            progress.value = completed;
            count.textContent = `已处理 ${completed} / ${total}（${Math.round(completed / total * 100)}%）`;
            result.textContent = `${archive ? '已准备' : '已保存'} ${completed - failed} · 失败 ${failed}`;
        },
        finish(message) {
            title.textContent = message;
            button.disabled = false;
            button.focus();
        }
    };
}

/** Pick one destination before loading originals, then report completed writes. */
export async function downloadHistoryBatch(ids, {
    getHistoryEntry, showToast, documentRef = document, windowRef = window
}) {
    if (!ids.length) {
        showToast('请先选择要下载的历史记录', 'warn');
        return false;
    }
    if (batchDownloading || documentRef.querySelector('.history-download-progress[open]')) return false;

    batchDownloading = true;
    const desktop = windowRef.__cainflowDesktop;
    let token;
    let directory;
    let progress;
    try {
        if (desktop?.beginDirectorySave) {
            token = await desktop.beginDirectorySave();
            if (!token) return false;
        } else if (typeof windowRef.showDirectoryPicker === 'function') {
            directory = await windowRef.showDirectoryPicker({ mode: 'readwrite' });
        }

        const archive = !token && !directory ? [] : null;
        let completed = 0;
        let failed = 0;
        try {
            progress = openDownloadProgress(ids.length, Boolean(archive), documentRef);
            progress.update(completed, failed);
            for (const id of ids) {
                try {
                    const { name, source } = getBatchFile(await getHistoryEntry(id), id);
                    if (token) {
                        if (!await desktop.saveFileToDirectory(token, name, source)) throw new Error('文件未写入');
                    } else if (directory) {
                        await saveToBrowserDirectory(directory, name, source);
                    } else {
                        const blob = await readDownloadBlob(source);
                        archive.push({ path: name, bytes: new Uint8Array(await blob.arrayBuffer()) });
                    }
                } catch {
                    failed += 1;
                }
                completed += 1;
                progress.update(completed, failed);
            }
        } finally {
            if (token) await desktop.endDirectorySave(token);
        }

        if (archive?.length) {
            const blob = createZipBlob(archive);
            if (desktop?.saveFile) {
                if (!await desktop.saveFile('cainflow_history.zip', blob.type, blob)) {
                    progress.finish('已取消保存压缩包');
                    return false;
                }
            } else if (!downloadBlob(blob, 'cainflow_history.zip', documentRef, windowRef)) {
                throw new Error('无法发起压缩包下载');
            }
        }

        const message = archive?.length
            ? (desktop?.saveFile ? '压缩包已保存' : '压缩包下载已发起')
            : '保存完成';
        progress.finish(failed === ids.length ? '下载失败' : message + (failed ? '，部分文件失败' : ''));
        return failed === 0;
    } catch (error) {
        if (!progress && error?.name === 'AbortError') return false;
        const message = '批量下载失败：' + (error?.message || error);
        if (progress) progress.finish(message);
        else showToast(message, 'error');
        return false;
    } finally {
        batchDownloading = false;
    }
}
