/**
 * CainFlow Image Utility Module
 * Contains functions for image processing, resolution handling, and downloads.
 */

/**
 * Get resolution display text from data URL
 */
export function getImageResolution(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(`${img.naturalWidth} × ${img.naturalHeight}`);
        img.onerror = () => resolve('');
        img.src = dataUrl;
    });
}

/**
 * Auto-resize image if total pixels exceed maxTotalPixels
 */
export function processImageResolution(dataUrl, maxTotalPixels = 4000000) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            const currentPixels = w * h;

            if (currentPixels <= maxTotalPixels) {
                resolve({ data: dataUrl, resized: false, originalRes: `${w}x${h}` });
                return;
            }

            const scale = Math.sqrt(maxTotalPixels / currentPixels);
            const newW = Math.floor(w * scale);
            const newH = Math.floor(h * scale);

            const canvas = document.createElement('canvas');
            canvas.width = newW;
            canvas.height = newH;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, newW, newH);

            const resizedData = canvas.toDataURL('image/png');
            resolve({
                data: resizedData,
                resized: true,
                originalRes: `${w}x${h}`,
                newRes: `${newW}x${newH}`
            });
        };
        img.onerror = () => resolve({ data: dataUrl, resized: false });
        img.src = dataUrl;
    });
}

/**
 * Convert dataURL to Blob
 */
export function dataURLtoBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    return new Blob([u8arr], { type: mime });
}

/**
 * Create a square thumbnail
 */
export function createThumbnail(dataUrl, size = 256) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            let sx = 0, sy = 0, sw = img.width, sh = img.height;
            if (sw > sh) {
                sx = (sw - sh) / 2;
                sw = sh;
            } else if (sh > sw) {
                sy = (sh - sw) / 2;
                sh = sw;
            }
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
            resolve(canvas.toDataURL('image/webp', 0.8));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

/**
 * Download image to local
 */
export function downloadImage(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename || 'cainflow_export.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
