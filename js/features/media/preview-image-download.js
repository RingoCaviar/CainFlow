const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };

/** Save original bytes; reserve the browser picker during the click's user activation. */
export async function downloadPreviewImage(source, {
    windowRef = window, documentRef = document, fetchRef = fetch,
    showToast = () => {}, filename = 'cainflow_export'
} = {}) {
    let writable;
    try {
        if (!source) throw new Error('原图尚未加载，请稍后重试');
        const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        const sourceMime = source instanceof Blob ? source.type : /^data:([^;,]+)/i.exec(String(source))?.[1];
        const knownExtension = extensions[sourceMime] || /\.(png|jpe?g|webp|gif|avif|bmp|svg|tiff?)(?:[?#]|$)/i.exec(String(source))?.[1];
        const desktop = windowRef.__cainflowDesktop;
        // Unknown formats deliberately have no guessed extension: never label JPEG bytes as PNG.
        const handle = !desktop?.saveFile && typeof windowRef.showSaveFilePicker === 'function'
            ? await windowRef.showSaveFilePicker({ suggestedName: base + (knownExtension ? `.${knownExtension}` : '') })
            : null;
        let blob = source;
        if (!(blob instanceof Blob)) {
            const response = await fetchRef(source);
            if (!response.ok) throw new Error(`读取原图失败（HTTP ${response.status}）`);
            blob = await response.blob();
        }
        if (!blob.type.startsWith('image/')) throw new Error('无法识别原图格式');
        const extension = extensions[blob.type] || knownExtension;
        const name = base + (extension ? `.${extension}` : '');
        if (desktop?.saveFile) {
            if (!await desktop.saveFile(name, blob.type, blob)) return 'cancelled';
        } else if (handle) {
            writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            writable = null;
        } else {
            const url = URL.createObjectURL(blob);
            try {
                const link = documentRef.createElement('a');
                link.href = url;
                link.download = name;
                documentRef.body.appendChild(link);
                try { link.click(); } finally { link.remove(); }
            } finally {
                windowRef.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            showToast('已开始下载图片', 'success');
            return 'started';
        }
        showToast('图片已保存到本地', 'success');
        return 'saved';
    } catch (error) {
        if (writable) await writable.abort().catch(() => {});
        if (error?.name === 'AbortError' && !writable) return 'cancelled';
        showToast(`保存图片失败：${error.message || error}`, 'error');
        return 'failed';
    }
}
