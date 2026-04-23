/**
 * 提供图片处理相关的基础工具，例如分辨率读取、自动缩放与 dataURL 转 Blob。
 */
export function createMediaUtils({
    getImageMaxPixels,
    documentRef = document,
    imageCtor = Image,
    blobCtor = Blob,
    fileReaderCtor = FileReader,
    uint8ArrayCtor = Uint8Array,
    atobRef = atob,
    mathRef = Math
}) {
    function loadImageInfo(dataUrl) {
        return new Promise((resolve) => {
            const img = new imageCtor();
            img.onload = () => resolve({
                width: img.naturalWidth,
                height: img.naturalHeight,
                image: img
            });
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        });
    }

    function getImageResolution(dataUrl) {
        return new Promise((resolve) => {
            const img = new imageCtor();
            img.onload = () => resolve(`${img.naturalWidth} × ${img.naturalHeight}`);
            img.onerror = () => resolve('');
            img.src = dataUrl;
        });
    }

    function detectImageMime(dataUrl) {
        if (typeof dataUrl !== 'string') return 'image/png';
        const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
        return match?.[1]?.toLowerCase() || 'image/png';
    }

    function detectOutputFormat(dataUrl) {
        const mime = detectImageMime(dataUrl);
        if (mime === 'image/jpg') return 'image/jpeg';
        if (mime === 'image/jpeg' || mime === 'image/webp') return mime;
        return 'image/png';
    }

    function estimateDataUrlSize(dataUrl) {
        if (typeof dataUrl !== 'string') return 0;
        const commaIndex = dataUrl.indexOf(',');
        if (commaIndex === -1) return 0;
        const base64 = dataUrl.slice(commaIndex + 1);
        const padding = (base64.match(/=+$/) || [''])[0].length;
        return mathRef.max(0, mathRef.floor((base64.length * 3) / 4) - padding);
    }

    function normalizeDimension(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed)) return fallback;
        return mathRef.max(1, mathRef.min(16384, parsed));
    }

    function normalizeQuality(value, fallback = 0.92) {
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = Number(value);
        if (Number.isNaN(parsed)) return fallback;
        const normalized = parsed > 1 ? parsed / 100 : parsed;
        return mathRef.max(0.01, mathRef.min(1, normalized));
    }

    async function resizeImageData(dataUrl, options = {}) {
        const info = await loadImageInfo(dataUrl);
        if (!info) {
            return {
                dataUrl,
                originalWidth: 0,
                originalHeight: 0,
                outputWidth: 0,
                outputHeight: 0,
                outputFormat: detectOutputFormat(dataUrl),
                outputQuality: null,
                estimatedBytes: estimateDataUrlSize(dataUrl),
                reusedSource: true
            };
        }

        const { width: originalWidth, height: originalHeight, image } = info;
        const originalFormat = detectOutputFormat(dataUrl);
        const outputFormat = options.format || originalFormat;
        const isQualityFormat = outputFormat === 'image/jpeg' || outputFormat === 'image/webp';
        const outputQuality = isQualityFormat ? normalizeQuality(options.quality, 0.92) : null;

        let outputWidth = originalWidth;
        let outputHeight = originalHeight;

        if (options.maxTotalPixels) {
            const maxTotalPixels = mathRef.max(1, Number(options.maxTotalPixels) || 1);
            const currentPixels = originalWidth * originalHeight;
            if (currentPixels > maxTotalPixels) {
                const scale = mathRef.sqrt(maxTotalPixels / currentPixels);
                outputWidth = mathRef.max(1, mathRef.floor(originalWidth * scale));
                outputHeight = mathRef.max(1, mathRef.floor(originalHeight * scale));
            }
        } else if (options.mode === 'dimensions') {
            const fallbackWidth = originalWidth;
            const fallbackHeight = originalHeight;
            const keepAspect = options.keepAspect !== false;
            let targetWidth = normalizeDimension(options.targetWidth, fallbackWidth);
            let targetHeight = normalizeDimension(options.targetHeight, fallbackHeight);

            if (keepAspect) {
                if (options.targetWidth && !options.targetHeight) {
                    targetHeight = mathRef.max(1, mathRef.round(targetWidth * originalHeight / originalWidth));
                } else if (!options.targetWidth && options.targetHeight) {
                    targetWidth = mathRef.max(1, mathRef.round(targetHeight * originalWidth / originalHeight));
                }
            }

            outputWidth = targetWidth;
            outputHeight = targetHeight;
        } else if (options.mode === 'scale') {
            const scalePercent = mathRef.max(1, mathRef.min(100, Number(options.scalePercent) || 100));
            const scale = scalePercent / 100;
            outputWidth = mathRef.max(1, mathRef.round(originalWidth * scale));
            outputHeight = mathRef.max(1, mathRef.round(originalHeight * scale));
        }

        const sameDimensions = outputWidth === originalWidth && outputHeight === originalHeight;
        const sameFormat = outputFormat === originalFormat;
        const canReuseSource = sameDimensions && sameFormat && !isQualityFormat;

        if (canReuseSource) {
            return {
                dataUrl,
                originalWidth,
                originalHeight,
                outputWidth,
                outputHeight,
                outputFormat,
                outputQuality,
                estimatedBytes: estimateDataUrlSize(dataUrl),
                reusedSource: true
            };
        }

        const canvas = documentRef.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, outputWidth, outputHeight);

        const resizedData = isQualityFormat
            ? canvas.toDataURL(outputFormat, outputQuality)
            : canvas.toDataURL(outputFormat);

        return {
            dataUrl: resizedData,
            originalWidth,
            originalHeight,
            outputWidth,
            outputHeight,
            outputFormat,
            outputQuality,
            estimatedBytes: estimateDataUrlSize(resizedData),
            reusedSource: false
        };
    }

    async function processImageResolution(dataUrl, maxTotalPixels = null) {
        if (maxTotalPixels === null) maxTotalPixels = getImageMaxPixels() || 2048 * 2048;
        const info = await loadImageInfo(dataUrl);
        if (!info) return { data: dataUrl, resized: false };

        const { width, height } = info;
        const currentPixels = width * height;
        if (currentPixels <= maxTotalPixels) {
            return { data: dataUrl, resized: false, originalRes: `${width}x${height}` };
        }

        const result = await resizeImageData(dataUrl, { maxTotalPixels });
        return {
            data: result.dataUrl,
            resized: true,
            originalRes: `${width}x${height}`,
            newRes: `${result.outputWidth}x${result.outputHeight}`
        };
    }

    function dataURLtoBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const binary = atobRef(parts[1]);
        const bytes = new uint8ArrayCtor(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new blobCtor([bytes], { type: mime });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new fileReaderCtor();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Blob 转 data URL 失败'));
            reader.readAsDataURL(blob);
        });
    }

    return {
        detectImageMime,
        detectOutputFormat,
        estimateDataUrlSize,
        normalizeDimension,
        normalizeQuality,
        resizeImageData,
        getImageResolution,
        processImageResolution,
        dataURLtoBlob,
        blobToDataUrl
    };
}
