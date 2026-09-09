/**
 * 提供图片处理相关的基础工具，例如分辨率读取、自动缩放与 dataURL 转 Blob。
 */
import { normalizeColorResetConfig } from './color-reset-config.js';
export { normalizeColorResetConfig } from './color-reset-config.js';

function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boundedNeutralGains(r, g, b) {
    const safe = [r, g, b].map((value) => Math.max(1, Number(value) || 0));
    const target = median(safe);
    const clamp = (value) => Math.max(0.67, Math.min(1.5, value));
    return { r: clamp(target / safe[0]), g: clamp(target / safe[1]), b: clamp(target / safe[2]) };
}

function makeWhiteBalanceResult(status, gains, confidence, message, extra = {}) {
    return { status, gains, confidence, message, ...extra };
}

export function analyzeAutoWhiteBalance(pixelData) {
    const candidates = [];
    let eligibleCount = 0;
    for (let index = 0; index < pixelData.length; index += 4) {
        const r = pixelData[index]; const g = pixelData[index + 1]; const b = pixelData[index + 2]; const alpha = pixelData[index + 3];
        if (alpha < 128) continue;
        const max = Math.max(r, g, b); const min = Math.min(r, g, b);
        const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
        if (luminance < 24 || luminance > 242) continue;
        eligibleCount += 1;
        const saturation = max > 0 ? (max - min) / max : 0;
        if (saturation <= 0.5) candidates.push({ r, g, b, saturation, luminance });
    }
    const minimum = Math.max(4, Math.ceil(eligibleCount * 0.02));
    if (candidates.length < minimum) {
        return makeWhiteBalanceResult('needs-sample', { r: 1, g: 1, b: 1 }, 0, '未找到可靠中性色，请使用吸管取样');
    }
    candidates.sort((a, b) => (a.saturation - b.saturation) || (b.luminance - a.luminance));
    const selectedCount = Math.max(minimum, Math.ceil(candidates.length * 0.35));
    const selected = candidates.slice(0, selectedCount);
    const channels = ['r', 'g', 'b'];
    const centers = Object.fromEntries(channels.map((channel) => [channel, median(selected.map((pixel) => pixel[channel]))]));
    const channelDeviation = channels.reduce((sum, channel) => {
        const deviations = selected.map((pixel) => Math.abs(pixel[channel] - centers[channel]));
        return sum + median(deviations) / Math.max(1, centers[channel]);
    }, 0) / channels.length;
    const neutralScore = 1 - Math.min(1, median(selected.map((pixel) => pixel.saturation)) / 0.5);
    const coverageScore = Math.min(1, candidates.length / Math.max(1, eligibleCount * 0.1));
    const consistencyScore = 1 - Math.min(1, channelDeviation / 0.18);
    const confidence = Math.max(0, Math.min(1, neutralScore * 0.35 + consistencyScore * 0.5 + coverageScore * 0.15));
    if (confidence < 0.55) {
        return makeWhiteBalanceResult('needs-sample', { r: 1, g: 1, b: 1 }, confidence, '未找到可靠中性色，请使用吸管取样');
    }
    const level = confidence >= 0.78 ? '高' : '中';
    return makeWhiteBalanceResult('applied', boundedNeutralGains(centers.r, centers.g, centers.b), confidence, `已自动校正 · 置信度${level}`);
}

export function sampleWhiteBalanceRegion(pixelData, width, height, centerX, centerY) {
    const pixels = [];
    const x0 = Math.max(0, Math.round(centerX) - 2); const x1 = Math.min(width - 1, Math.round(centerX) + 2);
    const y0 = Math.max(0, Math.round(centerY) - 2); const y1 = Math.min(height - 1, Math.round(centerY) + 2);
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            const index = (y * width + x) * 4;
            const r = pixelData[index]; const g = pixelData[index + 1]; const b = pixelData[index + 2]; const alpha = pixelData[index + 3];
            const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
            if (alpha >= 128 && luminance >= 16 && luminance <= 245) pixels.push({ r, g, b });
        }
    }
    if (pixels.length < 3) return makeWhiteBalanceResult('invalid-sample', { r: 1, g: 1, b: 1 }, 0, '取样区域无有效像素，请重新选择');
    const centers = { r: median(pixels.map((p) => p.r)), g: median(pixels.map((p) => p.g)), b: median(pixels.map((p) => p.b)) };
    const filtered = pixels.filter((pixel) => Math.max(Math.abs(pixel.r - centers.r), Math.abs(pixel.g - centers.g), Math.abs(pixel.b - centers.b)) <= 48);
    if (filtered.length < 3) return makeWhiteBalanceResult('invalid-sample', { r: 1, g: 1, b: 1 }, 0, '取样颜色差异过大，请重新选择');
    const r = median(filtered.map((p) => p.r)); const g = median(filtered.map((p) => p.g)); const b = median(filtered.map((p) => p.b));
    return makeWhiteBalanceResult('applied', boundedNeutralGains(r, g, b), 1, '已从 5×5 区域取样');
}

export function mapPreviewPointToImage({ x, y, boxWidth, boxHeight, imageWidth, imageHeight }) {
    if (![boxWidth, boxHeight, imageWidth, imageHeight].every((value) => Number(value) > 0)) return null;
    const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
    const shownWidth = imageWidth * scale; const shownHeight = imageHeight * scale;
    const offsetX = (boxWidth - shownWidth) / 2; const offsetY = (boxHeight - shownHeight) / 2;
    if (x < offsetX || y < offsetY || x > offsetX + shownWidth || y > offsetY + shownHeight) return null;
    const imageX = Math.max(0, Math.min(imageWidth - 1, Math.floor((x - offsetX) / scale)));
    const imageY = Math.max(0, Math.min(imageHeight - 1, Math.floor((y - offsetY) / scale)));
    return { x: imageX, y: imageY, xRatio: imageX / imageWidth, yRatio: imageY / imageHeight };
}

export function calculateNeutralWhiteBalanceGains(r, g, b) {
    return boundedNeutralGains(r, g, b);
}

export function calculateGrayWorldGains(pixelData) {
    let r = 0; let g = 0; let b = 0; let count = 0;
    for (let index = 0; index < pixelData.length; index += 4) {
        const alpha = pixelData[index + 3] / 255;
        if (alpha <= 0) continue;
        r += pixelData[index] * alpha;
        g += pixelData[index + 1] * alpha;
        b += pixelData[index + 2] * alpha;
        count += alpha;
    }
    return count > 0 ? calculateNeutralWhiteBalanceGains(r / count, g / count, b / count) : { r: 1, g: 1, b: 1 };
}

export function applyColorResetToPixels(pixelData, options = {}) {
    const config = normalizeColorResetConfig(options);
    const analysis = config.whiteBalanceMode === 'auto'
        ? (options.whiteBalanceAnalysis || analyzeAutoWhiteBalance(pixelData))
        : null;
    const gains = config.whiteBalanceMode === 'auto'
        ? (analysis.status === 'applied' ? analysis.gains : { r: 1, g: 1, b: 1 })
        : (config.whiteBalanceMode === 'custom' ? config.whiteBalanceGains : { r: 1, g: 1, b: 1 });
    const temperature = config.temperature / 100;
    const tint = config.tint / 100;
    const saturation = 1 + config.saturation / 100;
    const vibrance = config.vibrance / 100;
    const output = new Uint8ClampedArray(pixelData.length);
    const clampByte = (value) => Math.max(0, Math.min(255, value));

    for (let index = 0; index < pixelData.length; index += 4) {
        let r = pixelData[index] * gains.r;
        let g = pixelData[index + 1] * gains.g;
        let b = pixelData[index + 2] * gains.b;

        r *= 1 + Math.max(0, temperature) * 0.35;
        b *= 1 + Math.max(0, -temperature) * 0.35;
        r *= 1 - Math.max(0, -temperature) * 0.18;
        b *= 1 - Math.max(0, temperature) * 0.18;
        r *= 1 + Math.max(0, tint) * 0.12;
        b *= 1 + Math.max(0, tint) * 0.12;
        g *= 1 + Math.max(0, -tint) * 0.25;
        g *= 1 - Math.max(0, tint) * 0.18;

        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        const lightness = (maxChannel + minChannel) / 2;
        const chroma = maxChannel - minChannel;
        const currentSaturation = maxChannel > 0 ? chroma / maxChannel : 0;
        const vibranceFactor = 1 + vibrance * (1 - currentSaturation) * (vibrance >= 0 ? 1 : 0.75);
        r = lightness + (r - lightness) * vibranceFactor;
        g = lightness + (g - lightness) * vibranceFactor;
        b = lightness + (b - lightness) * vibranceFactor;

        const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
        output[index] = clampByte(luminance + (r - luminance) * saturation);
        output[index + 1] = clampByte(luminance + (g - luminance) * saturation);
        output[index + 2] = clampByte(luminance + (b - luminance) * saturation);
        output[index + 3] = pixelData[index + 3];
    }
    return { pixels: output, gains, config, whiteBalanceAnalysis: analysis };
}

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

    async function processColorResetImage(dataUrl, options = {}) {
        const info = await loadImageInfo(dataUrl);
        if (!info) throw new Error('无法解码输入图片');
        const config = normalizeColorResetConfig(options);
        const unchanged = config.whiteBalanceMode === 'original'
            && config.temperature === 0 && config.tint === 0
            && config.vibrance === 0 && config.saturation === 0;
        const outputFormat = detectOutputFormat(dataUrl);
        if (unchanged) {
            return { dataUrl, width: info.width, height: info.height, outputWidth: info.width, outputHeight: info.height, outputFormat, estimatedBytes: estimateDataUrlSize(dataUrl), whiteBalanceGains: { r: 1, g: 1, b: 1 }, whiteBalanceAnalysis: makeWhiteBalanceResult('applied', { r: 1, g: 1, b: 1 }, 1, '原始设置'), reusedSource: true };
        }
        const canvas = documentRef.createElement('canvas');
        canvas.width = info.width;
        canvas.height = info.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(info.image, 0, 0);
        const imageData = context.getImageData(0, 0, info.width, info.height);
        let whiteBalanceAnalysis = null;
        if (config.whiteBalanceMode === 'auto') {
            const scale = Math.min(1, 256 / Math.max(info.width, info.height));
            const analysisCanvas = documentRef.createElement('canvas');
            analysisCanvas.width = Math.max(1, Math.round(info.width * scale));
            analysisCanvas.height = Math.max(1, Math.round(info.height * scale));
            const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true });
            analysisContext.drawImage(info.image, 0, 0, analysisCanvas.width, analysisCanvas.height);
            whiteBalanceAnalysis = analyzeAutoWhiteBalance(analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height).data);
        } else if (config.whiteBalanceMode === 'custom' && options.samplePoint) {
            const x = Math.max(0, Math.min(info.width - 1, Math.floor(options.samplePoint.xRatio * info.width)));
            const y = Math.max(0, Math.min(info.height - 1, Math.floor(options.samplePoint.yRatio * info.height)));
            whiteBalanceAnalysis = sampleWhiteBalanceRegion(imageData.data, info.width, info.height, x, y);
            whiteBalanceAnalysis.samplePoint = { xRatio: options.samplePoint.xRatio, yRatio: options.samplePoint.yRatio };
            if (whiteBalanceAnalysis.status === 'applied') {
                const px = Math.round(options.samplePoint.xRatio * 100);
                const py = Math.round(options.samplePoint.yRatio * 100);
                whiteBalanceAnalysis.message = `已从 5×5 区域取样 · ${px}%, ${py}%`;
            }
            if (whiteBalanceAnalysis.status === 'applied') config.whiteBalanceGains = whiteBalanceAnalysis.gains;
        } else if (config.whiteBalanceMode === 'custom') {
            whiteBalanceAnalysis = makeWhiteBalanceResult('applied', config.whiteBalanceGains, 1, options.whiteBalanceMessage || '已应用自定义白平衡');
        }
        const result = applyColorResetToPixels(imageData.data, { ...config, whiteBalanceAnalysis });
        imageData.data.set(result.pixels);
        context.putImageData(imageData, 0, 0);
        const outputQuality = outputFormat === 'image/jpeg' || outputFormat === 'image/webp' ? 0.92 : undefined;
        const outputData = outputQuality ? canvas.toDataURL(outputFormat, outputQuality) : canvas.toDataURL(outputFormat);
        const resolvedAnalysis = whiteBalanceAnalysis || makeWhiteBalanceResult('applied', result.gains, 1, '原始设置');
        return { dataUrl: outputData, width: info.width, height: info.height, outputWidth: info.width, outputHeight: info.height, outputFormat, estimatedBytes: estimateDataUrlSize(outputData), whiteBalanceGains: result.gains, whiteBalanceAnalysis: resolvedAnalysis, reusedSource: false };
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
        processColorResetImage,
        getImageResolution,
        processImageResolution,
        dataURLtoBlob,
        blobToDataUrl
    };
}
