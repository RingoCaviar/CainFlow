/**
 * Shared preview cache utilities for media thumbnails and resolution lookups.
 */

export const TRANSPARENT_PREVIEW_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function createMediaPreviewCache({
    getImageResolution,
    documentRef = document,
    windowRef = window,
    resolutionCacheLimit = 120,
    dataUrlResolutionCacheLimit = 24,
    previewThumbnailMaxEdge = 480,
    previewThumbnailCacheLimit = 24
}) {
    const resolutionCache = new Map();
    const previewThumbnailCache = new Map();

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value);
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function hashString(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getImageCacheKey(value = '') {
        const source = String(value || '');
        if (!source) return '';
        if (source.length <= 256) return source;
        return `${source.length}:${source.slice(0, 96)}:${source.slice(-96)}:${hashString(source)}`;
    }

    function trimPreviewThumbnailCache(nextKey = '') {
        if (nextKey && previewThumbnailCache.has(nextKey)) return;
        while (previewThumbnailCache.size >= previewThumbnailCacheLimit) {
            const oldestKey = previewThumbnailCache.keys().next().value;
            if (!oldestKey) break;
            previewThumbnailCache.delete(oldestKey);
        }
    }

    function getCachedPreviewThumbnail(source) {
        const cacheKey = getImageCacheKey(source);
        const cached = previewThumbnailCache.get(cacheKey);
        return typeof cached === 'string' ? cached : '';
    }

    function createPreviewThumbnail(source, maxEdge = previewThumbnailMaxEdge) {
        if (!isInlineImageData(source)) return Promise.resolve(source);
        const cacheKey = getImageCacheKey(source);
        const cached = previewThumbnailCache.get(cacheKey);
        if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);

        trimPreviewThumbnailCache(cacheKey);
        const pending = new Promise((resolve) => {
            const ImageCtor = windowRef?.Image || Image;
            const img = new ImageCtor();
            const finish = (value) => {
                img.onload = null;
                img.onerror = null;
                img.removeAttribute?.('src');
                resolve(value);
            };
            img.onload = () => {
                const width = img.naturalWidth || img.width || 0;
                const height = img.naturalHeight || img.height || 0;
                const longestEdge = Math.max(width, height);
                if (!width || !height || longestEdge <= maxEdge) {
                    previewThumbnailCache.delete(cacheKey);
                    finish(source);
                    return;
                }

                const scale = maxEdge / longestEdge;
                const outputWidth = Math.max(1, Math.round(width * scale));
                const outputHeight = Math.max(1, Math.round(height * scale));
                const canvas = documentRef.createElement('canvas');
                canvas.width = outputWidth;
                canvas.height = outputHeight;
                const ctx = canvas.getContext('2d', { alpha: true });
                if (!ctx) {
                    previewThumbnailCache.delete(cacheKey);
                    finish(source);
                    return;
                }
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'medium';
                ctx.drawImage(img, 0, 0, outputWidth, outputHeight);
                let thumbnail = '';
                try {
                    thumbnail = canvas.toDataURL('image/webp', 0.76);
                } catch {
                    thumbnail = '';
                }
                canvas.width = 0;
                canvas.height = 0;
                if (thumbnail) previewThumbnailCache.set(cacheKey, thumbnail);
                else previewThumbnailCache.delete(cacheKey);
                finish(thumbnail || source);
            };
            img.onerror = () => {
                previewThumbnailCache.delete(cacheKey);
                finish(source);
            };
            img.decoding = 'async';
            img.src = source;
        });
        previewThumbnailCache.set(cacheKey, pending);
        return pending;
    }

    function clearPreviewThumbnailCache() {
        previewThumbnailCache.clear();
    }

    function getResolutionCacheKey(value) {
        const source = String(value || '').trim();
        if (!source) return '';
        if (!isInlineImageData(source)) return `url:${source}`;
        const commaIndex = source.indexOf(',');
        const header = commaIndex >= 0 ? source.slice(0, commaIndex) : source.slice(0, 64);
        const payload = commaIndex >= 0 ? source.slice(commaIndex + 1) : source;
        const midStart = Math.max(0, Math.floor(payload.length / 2) - 48);
        const sample = [
            payload.slice(0, 96),
            payload.slice(midStart, midStart + 96),
            payload.slice(Math.max(0, payload.length - 96))
        ].join(':');
        return `data:${header}:len=${source.length}:h=${hashString(sample)}`;
    }

    function trimResolutionCache(cacheKey) {
        const isNewKey = !resolutionCache.has(cacheKey);
        while (resolutionCache.size >= resolutionCacheLimit && isNewKey) {
            const oldestKey = resolutionCache.keys().next().value;
            if (oldestKey === undefined) break;
            resolutionCache.delete(oldestKey);
        }
        if (!cacheKey.startsWith('data:') || !isNewKey) return;

        let dataUrlCacheCount = 0;
        for (const key of resolutionCache.keys()) {
            if (key.startsWith('data:')) dataUrlCacheCount += 1;
        }
        while (dataUrlCacheCount >= dataUrlResolutionCacheLimit) {
            let oldestDataKey;
            for (const key of resolutionCache.keys()) {
                if (key.startsWith('data:')) {
                    oldestDataKey = key;
                    break;
                }
            }
            if (oldestDataKey === undefined) break;
            resolutionCache.delete(oldestDataKey);
            dataUrlCacheCount -= 1;
        }
    }

    function getReloadableImageUrl(imageUrl) {
        if (!isRemoteImageUrl(imageUrl)) return imageUrl || '';
        try {
            const url = new URL(imageUrl);
            url.searchParams.set('_cf_preview_reload', String(Date.now()));
            return url.toString();
        } catch {
            const separator = imageUrl.includes('?') ? '&' : '?';
            return `${imageUrl}${separator}_cf_preview_reload=${Date.now()}`;
        }
    }

    async function resolveImageResolution(value) {
        if (typeof value !== 'string' || !value.trim()) return '';
        const source = value.trim();
        const cacheKey = getResolutionCacheKey(source);
        const cached = resolutionCache.get(cacheKey);
        if (cached !== undefined) {
            return cached instanceof Promise ? cached : Promise.resolve(cached);
        }

        const pending = Promise.resolve(getImageResolution(source))
            .then((result) => {
                const normalized = typeof result === 'string' ? result : '';
                trimResolutionCache(cacheKey);
                resolutionCache.set(cacheKey, normalized);
                return normalized;
            })
            .catch(() => {
                resolutionCache.delete(cacheKey);
                return '';
            });
        trimResolutionCache(cacheKey);
        resolutionCache.set(cacheKey, pending);
        return pending;
    }

    return {
        clearPreviewThumbnailCache,
        createPreviewThumbnail,
        getCachedPreviewThumbnail,
        getReloadableImageUrl,
        resolveImageResolution
    };
}
