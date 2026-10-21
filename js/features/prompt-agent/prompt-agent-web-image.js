// Temporary preview cache only. Imported originals are persisted through Media assets.
export function createAgentWebImageReader({ fetchRef = fetch, decode = async data => {
    const image = new Image(); image.src = data; await image.decode();
} } = {}) {
    const cache = new Map();
    return async function read(url, { signal } = {}) {
        if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
        if (cache.has(url)) return cache.get(url);
        const response = await fetchRef('/api/media/search-image', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `图片读取失败（HTTP ${response.status}）`);
        }
        const blob = await response.blob();
        if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type) || blob.size > 20 * 1024 * 1024) throw new Error('图片内容或大小无效');
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
        });
        await decode(data);
        if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
        // Keep at most four small previews; never retain an unbounded original batch.
        if (data.length < 1024 * 1024) { if (cache.size >= 4) cache.delete(cache.keys().next().value); cache.set(url, data); }
        return data;
    };
}
