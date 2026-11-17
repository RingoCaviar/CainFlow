/**
 * Shared preview cache utilities for media thumbnails and resolution lookups.
 */

export const TRANSPARENT_PREVIEW_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function createPreviewPriority(initial = 0) {
    const listeners = new Set();
    let value = initial;
    return {
        get value() { return value; },
        set(next) {
            if (next === value) return;
            const previous = value;
            value = next;
            for (const listen of listeners) listen(next, previous);
        },
        subscribe(listen) {
            listeners.add(listen);
            return () => listeners.delete(listen);
        }
    };
}

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
    const pendingImages = new Map();
    const queuedImages = new Set();
    const visibleImages = new Set();
    const imageStartsPerFrame = 2;
    const maxQueueChecksPerFrame = 32;
    let inFlight = 0;
    let scheduled = null;
    let visibleStarts = 0;

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

    function getImageCacheKey(source) {
        if (source.length <= 256) return source;
        const middle = Math.floor(source.length / 2);
        const sample = source.slice(0, 96) + source.slice(middle - 48, middle + 48) + source.slice(-96);
        return `${source.length}:${hashString(sample)}`;
    }

    function getCompletedImage(cache, key, source) {
        const record = cache.get(key);
        if (!record || (source.length > 256 && record.fingerprint !== hashString(source))) return null;
        return record;
    }

    function normalizeMaxEdge(maxEdge) {
        return Math.max(1, Number(maxEdge) || previewThumbnailMaxEdge);
    }

    function getCachedPreviewThumbnail(source, maxEdge = previewThumbnailMaxEdge) {
        if (!isInlineImageData(source)) return '';
        const key = `${getImageCacheKey(source)}@${normalizeMaxEdge(maxEdge)}`;
        return getCompletedImage(previewThumbnailCache, key, source)?.thumbnail || '';
    }

    function createPreviewThumbnail(source, maxEdge = previewThumbnailMaxEdge, options = {}) {
        if (!isInlineImageData(source)) return Promise.resolve(source);
        // Each maximum edge is an independent, disposable display MIPmap.
        // The source data URL remains authoritative and is never rewritten.
        const edge = normalizeMaxEdge(maxEdge);
        const pending = pendingImages.get(source);
        const existing = pending?.thumbnails.get(edge);
        if (existing) {
            trackInterest(pending, existing, options);
            return existing.promise;
        }
        const imageKey = getImageCacheKey(source);
        const cached = getCompletedImage(previewThumbnailCache, `${imageKey}@${edge}`, source)?.thumbnail;
        if (cached) return Promise.resolve(cached);
        const measurements = getCompletedImage(resolutionCache, `data:${imageKey}`, source);
        if (measurements?.longestEdge <= edge) return Promise.resolve(source);
        const job = pending || getPendingImage(source);
        const request = deferred();
        trackInterest(job, request, options);
        job.thumbnails.set(edge, request);
        return request.promise;
    }

    function deferred() {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve, interests: new Set() };
    }

    function getPendingImage(source) {
        const existing = pendingImages.get(source);
        if (existing) return existing;
        const job = {
            source, thumbnails: new Map(), resolution: deferred(),
            prioritySubscriptions: new Map(), visibleVotes: 0, fixedPriority: false
        };
        pendingImages.set(source, job);
        queuedImages.add(job);
        scheduleImageJobs();
        return job;
    }

    function updateVisibility(job, delta) {
        job.visibleVotes += delta;
        if (job.visibleVotes > 0) visibleImages.add(job);
        else visibleImages.delete(job);
    }

    function trackInterest(job, request, { priority = 0, isCurrent } = {}) {
        request.interests.add(isCurrent);
        if (!queuedImages.has(job)) return;
        if (priority?.subscribe) {
            if (job.prioritySubscriptions.has(priority)) return;
            const unsubscribe = priority.subscribe((next, previous) => {
                updateVisibility(job, Number(next > 0) - Number(previous > 0));
            });
            job.prioritySubscriptions.set(priority, unsubscribe);
            if (priority.value > 0) updateVisibility(job, 1);
        } else if (priority > 0 && !job.fixedPriority) {
            job.fixedPriority = true;
            updateVisibility(job, 1);
        }
    }

    function hasLiveInterest(request) {
        if (request.interests.has(undefined)) return true;
        for (const isCurrent of request.interests) {
            try {
                if (isCurrent?.()) return true;
            } catch {
                // A detached consumer must not block other queued previews.
            }
        }
        return false;
    }

    function hasLiveJob(job) {
        if (hasLiveInterest(job.resolution)) return true;
        for (const request of job.thumbnails.values()) {
            if (hasLiveInterest(request)) return true;
        }
        return false;
    }

    function resolveFallback({ source, resolution, thumbnails }) {
        resolution.resolve('');
        for (const request of thumbnails.values()) request.resolve(source);
    }

    function unqueueImage(job) {
        queuedImages.delete(job);
        visibleImages.delete(job);
        for (const unsubscribe of job.prioritySubscriptions.values()) unsubscribe();
        job.prioritySubscriptions.clear();
    }

    function nextImageJob() {
        // Allow an older background request through when visible requests keep arriving.
        const visible = visibleStarts < 4 && visibleImages.values().next().value;
        return { job: visible || queuedImages.values().next().value, visible };
    }

    function scheduleImageJobs() {
        if (scheduled || !queuedImages.size || inFlight >= imageStartsPerFrame) return;
        const token = {};
        scheduled = token;
        const drain = () => {
            if (scheduled !== token) return;
            scheduled = null;
            let checked = 0;
            while (inFlight < imageStartsPerFrame && queuedImages.size && checked < maxQueueChecksPerFrame) {
                checked += 1;
                const { job, visible } = nextImageJob();
                unqueueImage(job);
                if (!hasLiveJob(job)) {
                    pendingImages.delete(job.source);
                    resolveFallback(job);
                    continue;
                }
                visibleStarts = visible ? visibleStarts + 1 : 0;
                inFlight += 1;
                void runImageJob(job);
            }
            scheduleImageJobs();
        };
        if (documentRef.visibilityState !== 'hidden' && windowRef?.requestAnimationFrame) {
            windowRef.requestAnimationFrame(drain);
        } else if (windowRef?.setTimeout) {
            windowRef.setTimeout(drain, 16);
        } else {
            setTimeout(drain, 16);
        }
    }

    documentRef.addEventListener?.('visibilitychange', () => {
        if (documentRef.visibilityState !== 'hidden' || !scheduled) return;
        scheduled = null;
        scheduleImageJobs();
    });

    function readImage(source) {
        return new Promise((resolve) => {
            const ImageCtor = windowRef?.Image || globalThis.Image;
            const img = new ImageCtor();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.decoding = 'async';
            img.src = source;
        });
    }

    function encodeThumbnail(canvas) {
        const FileReaderCtor = windowRef?.FileReader || globalThis.FileReader;
        if (!canvas.toBlob || !FileReaderCtor) return canvas.toDataURL('image/webp', 0.76);
        return new Promise((resolve) => canvas.toBlob((blob) => {
            if (!blob) { resolve(''); return; }
            try {
                const reader = new FileReaderCtor();
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = reader.onabort = () => resolve('');
                reader.readAsDataURL(blob);
            } catch {
                resolve('');
            }
        }, 'image/webp', 0.76));
    }

    async function drawThumbnail(img, width, height, longestEdge, edge) {
        const canvas = documentRef.createElement('canvas');
        try {
            canvas.width = Math.max(1, Math.round(width * edge / longestEdge));
            canvas.height = Math.max(1, Math.round(height * edge / longestEdge));
            const context = canvas.getContext('2d', { alpha: true });
            if (!context) return '';
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'medium';
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            return await encodeThumbnail(canvas);
        } catch {
            return '';
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    }

    async function runImageJob(job) {
        const { source, thumbnails, resolution } = job;
        let img;
        try {
            img = await readImage(source);
            const width = img?.naturalWidth || img?.width || 0;
            const height = img?.naturalHeight || img?.height || 0;
            if (!width || !height || !hasLiveJob(job)) return;

            const longestEdge = Math.max(width, height);
            const imageKey = getImageCacheKey(source);
            const fingerprint = source.length > 256 ? hashString(source) : '';
            const dimensions = `${width} × ${height}`;
            if (pendingImages.get(source) === job) {
                const key = `data:${imageKey}`;
                trimResolutionCache(key);
                resolutionCache.set(key, { dimensions, longestEdge, fingerprint });
            }
            resolution.resolve(dimensions);
            for (const [edge, request] of thumbnails) {
                if (!hasLiveInterest(request)) {
                    thumbnails.delete(edge);
                    request.resolve(source);
                    continue;
                }
                const thumbnail = longestEdge > edge ? await drawThumbnail(img, width, height, longestEdge, edge) : '';
                if (thumbnail && pendingImages.get(source) === job && previewThumbnailCacheLimit > 0) {
                    const key = `${imageKey}@${edge}`;
                    previewThumbnailCache.delete(key);
                    previewThumbnailCache.set(key, { fingerprint, thumbnail });
                    while (previewThumbnailCache.size > previewThumbnailCacheLimit) {
                        previewThumbnailCache.delete(previewThumbnailCache.keys().next().value);
                    }
                }
                request.resolve(thumbnail || source);
            }
        } catch {
            // Decode failure falls back to the original display source.
        } finally {
            if (img) {
                img.onload = img.onerror = null;
                img.removeAttribute?.('src');
            }
            if (pendingImages.get(source) === job) pendingImages.delete(source);
            resolveFallback(job);
            inFlight -= 1;
            scheduleImageJobs();
        }
    }

    function clearPreviewThumbnailCache() {
        previewThumbnailCache.clear();
        pendingImages.clear();
        scheduled = null;
        visibleStarts = 0;
        for (const job of queuedImages) {
            unqueueImage(job);
            resolveFallback(job);
        }
    }

    function createDisplayMipmap(source, maxEdge, options) {
        return createPreviewThumbnail(source, maxEdge, options);
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

    async function resolveImageResolution(value, options = {}) {
        if (typeof value !== 'string' || !value.trim()) return '';
        const source = value.trim();
        if (isInlineImageData(source)) {
            const cached = getCompletedImage(resolutionCache, `data:${getImageCacheKey(source)}`, source);
            if (cached) return cached.dimensions;
            const job = getPendingImage(source);
            trackInterest(job, job.resolution, options);
            return job.resolution.promise;
        }
        const cacheKey = `url:${source}`;
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
        createDisplayMipmap,
        createPreviewThumbnail,
        getCachedPreviewThumbnail,
        getReloadableImageUrl,
        resolveImageResolution
    };
}
