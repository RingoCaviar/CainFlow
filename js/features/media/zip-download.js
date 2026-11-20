import { createZipBlobFromSources } from '../../core/zip-archive.js';

async function buildZipArchive(entries, windowRef, signal) {
    if (typeof windowRef.Worker !== 'function') return createZipBlobFromSources(entries);

    let worker;
    let onAbort;
    let result;
    try {
        worker = new windowRef.Worker(new URL('../../core/zip-archive-worker.js', import.meta.url), { type: 'module' });
        result = await new Promise((resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            worker.addEventListener('message', ({ data }) => resolve(data), { once: true });
            const unavailable = event => {
                event.preventDefault();
                reject(new Error('ZIP Worker 无法运行'));
            };
            worker.addEventListener('error', unavailable, { once: true });
            worker.addEventListener('messageerror', unavailable, { once: true });
            // Blob entries can cross the worker boundary without copying their bytes in JavaScript.
            worker.postMessage(entries);
        });
    } catch {
        signal?.throwIfAborted();
        return createZipBlobFromSources(entries);
    } finally {
        worker?.terminate();
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }

    if (result.error) throw new Error(result.error);
    return result.archive;
}

export async function saveZipArchive(filename, readEntries, { windowRef = window, documentRef = document, signal } = {}) {
    signal?.throwIfAborted();
    const desktop = windowRef.__cainflowDesktop;
    let handle;
    if (!desktop?.saveFile && typeof windowRef.showSaveFilePicker === 'function') {
        // The browser picker must open within the export click's user activation.
        try {
            handle = await windowRef.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }]
            });
        } catch (error) {
            if (error?.name === 'AbortError') return 'cancelled';
            throw error;
        }
    }

    signal?.throwIfAborted();
    const entries = await readEntries();
    signal?.throwIfAborted();
    if (!entries.length) throw new Error('没有可导出的文件');
    const archive = await buildZipArchive(entries, windowRef, signal);
    signal?.throwIfAborted();
    if (desktop?.saveFile) {
        return await desktop.saveFile(filename, archive.type, archive) ? 'saved' : 'cancelled';
    }
    if (handle) {
        const writable = await handle.createWritable();
        try {
            await writable.write(archive);
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
        return 'saved';
    }

    const url = URL.createObjectURL(archive);
    try {
        const link = documentRef.createElement('a');
        link.href = url;
        link.download = filename;
        documentRef.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
    } finally {
        windowRef.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return 'started';
}
