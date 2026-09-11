/**
 * 提供通用 UI 辅助函数，例如图片下载与剪贴板复制。
 */
export function createUiUtils({
    showToast,
    onNativeClipboardWrite = null,
    documentRef = document,
    navigatorRef = navigator,
    fetchRef = fetch,
    clipboardItemCtor = globalThis.ClipboardItem,
    urlApi = globalThis.URL
}) {
    function downloadImage(dataUrl, filename) {
        try {
            const link = documentRef.createElement('a');
            link.href = dataUrl;
            link.download = filename || 'cainflow_export.png';
            documentRef.body.appendChild(link);
            link.click();
            documentRef.body.removeChild(link);
            return true;
        } catch (error) {
            return false;
        }
    }

    function copyToClipboard(text) {
        navigatorRef.clipboard.writeText(text).then(() => {
            onNativeClipboardWrite?.();
            showToast('已复制到剪贴板', 'success');
        }).catch((err) => {
            console.error('Copy failed:', err);
            showToast('复制失败', 'error');
        });
    }

    async function copyImageToClipboard(source) {
        if (!source || typeof navigatorRef.clipboard?.write !== 'function' || typeof clipboardItemCtor !== 'function') {
            showToast('当前环境不支持复制图片', 'error');
            return false;
        }
        try {
            const response = await fetchRef(source);
            if (!response?.ok) throw new Error('无法读取图片');
            const blob = await response.blob();
            if (!blob?.type?.startsWith('image/')) throw new Error('不是可复制的图片');
            const clipboardBlob = blob.type === 'image/png'
                ? blob
                : await convertImageToPng(blob);
            await navigatorRef.clipboard.write([new clipboardItemCtor({ 'image/png': clipboardBlob })]);
            onNativeClipboardWrite?.();
            showToast('图片已复制到剪贴板', 'success');
            return true;
        } catch (error) {
            console.error('Copy image failed:', error);
            showToast('复制图片失败', 'error');
            return false;
        }
    }

    function convertImageToPng(blob) {
        return new Promise((resolve, reject) => {
            const image = documentRef.createElement?.('img');
            const objectUrl = urlApi?.createObjectURL?.(blob);
            if (!image || !objectUrl) {
                reject(new Error('当前环境无法转换图片'));
                return;
            }
            const release = () => urlApi.revokeObjectURL?.(objectUrl);
            image.onload = () => {
                const canvas = documentRef.createElement('canvas');
                canvas.width = image.naturalWidth || image.width;
                canvas.height = image.naturalHeight || image.height;
                const context = canvas.getContext?.('2d');
                if (!canvas.width || !canvas.height || !context) {
                    release();
                    reject(new Error('图片转换失败'));
                    return;
                }
                context.drawImage(image, 0, 0);
                canvas.toBlob((pngBlob) => {
                    release();
                    if (pngBlob) resolve(pngBlob);
                    else reject(new Error('图片转换失败'));
                }, 'image/png');
            };
            image.onerror = () => {
                release();
                reject(new Error('图片转换失败'));
            };
            image.src = objectUrl;
        });
    }

    return {
        downloadImage,
        copyToClipboard,
        copyImageToClipboard
    };
}
