import { createZipBlob } from '../../core/zip-archive.js';

export async function saveZipArchive(filename, readEntries, { windowRef = window, documentRef = document } = {}) {
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

    const entries = await readEntries();
    if (!entries.length) throw new Error('没有可导出的文件');
    const archive = createZipBlob(entries);
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
