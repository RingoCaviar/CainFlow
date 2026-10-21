// Read local headers only; never fetch remote images just to meter context.
export function readImageSize(url) {
    try {
        if (!/^data:image\/[^;]+;base64,/.test(url)) return null;
        const start = url.indexOf(',') + 1;
        const raw = atob(url.slice(start, start + 262144));
        const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        let width, height;
        if (view.getUint32(0) === 0x89504e47) {
            width = view.getUint32(16); height = view.getUint32(20);
        } else if (raw.startsWith('GIF8')) {
            width = view.getUint16(6, true); height = view.getUint16(8, true);
        } else if (raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP') {
            if (raw.slice(12, 16) === 'VP8X') {
                width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
                height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
            } else if (raw.slice(12, 16) === 'VP8L') {
                const bits = view.getUint32(21, true);
                width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
            } else if (raw.slice(12, 16) === 'VP8 ') {
                width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
            }
        } else if (view.getUint16(0) === 0xffd8) {
            for (let offset = 2; offset + 9 < bytes.length;) {
                if (bytes[offset] !== 0xff) break;
                const marker = bytes[offset + 1];
                if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                    height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break;
                }
                const length = view.getUint16(offset + 2);
                if (length < 2) break;
                offset += 2 + length;
            }
        }
        return width > 0 && height > 0 ? { width, height } : null;
    } catch { return null; }
}

export function measureImageTokens(url, modelId = '') {
    const size = readImageSize(url);
    const patchMultiplier = /^gpt-4\.1-mini(?:-|$)/.test(modelId) ? 1.62
        : /^gpt-4\.1-nano(?:-|$)/.test(modelId) ? 2.46 : /^o4-mini(?:-|$)/.test(modelId) ? 1.72 : null;
    if (patchMultiplier) {
        if (!size) return { tokens: Math.ceil(1536 * patchMultiplier), estimated: true };
        let { width, height } = size;
        if (Math.ceil(width / 32) * Math.ceil(height / 32) > 1536) {
            const shrink = Math.sqrt(1536 * 32 * 32 / (width * height));
            width *= shrink; height *= shrink;
            const align = Math.min(Math.floor(width / 32) / (width / 32), Math.floor(height / 32) / (height / 32));
            width *= align; height *= align;
        }
        return { tokens: Math.ceil(Math.min(1536, Math.ceil(width / 32) * Math.ceil(height / 32)) * patchMultiplier), estimated: false };
    }
    const mini = /^gpt-4o-mini(?:-|$)/.test(modelId);
    const tiled = mini || /^gpt-4o(?:-|$)|^gpt-4\.1(?:-\d|$)|^gpt-4-turbo(?:-|$)/.test(modelId);
    if (tiled) {
        const base = mini ? 2833 : 85, tile = mini ? 5667 : 170;
        if (!size) return { tokens: base + 16 * tile, estimated: true };
        let { width, height } = size;
        const fit = Math.min(1, 2048 / Math.max(width, height));
        width *= fit; height *= fit;
        const scale = Math.min(1, 768 / Math.min(width, height));
        width = Math.floor(width * scale); height = Math.floor(height * scale);
        return { tokens: base + tile * Math.ceil(width / 512) * Math.ceil(height / 512), estimated: false };
    }
    // Explicit reserve, not a claim of matching an unknown provider's tokenizer.
    return { tokens: 4096, estimated: true };
}
