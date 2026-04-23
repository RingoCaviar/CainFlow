/**
 * 提供通用 UI 辅助函数，例如图片下载与剪贴板复制。
 */
export function createUiUtils({
    showToast,
    documentRef = document,
    navigatorRef = navigator
}) {
    function downloadImage(dataUrl, filename) {
        const link = documentRef.createElement('a');
        link.href = dataUrl;
        link.download = filename || 'cainflow_export.png';
        documentRef.body.appendChild(link);
        link.click();
        documentRef.body.removeChild(link);
    }

    function copyToClipboard(text) {
        navigatorRef.clipboard.writeText(text).then(() => {
            showToast('已复制到剪贴板', 'success');
        }).catch((err) => {
            console.error('Copy failed:', err);
            showToast('复制失败', 'error');
        });
    }

    return {
        downloadImage,
        copyToClipboard
    };
}
