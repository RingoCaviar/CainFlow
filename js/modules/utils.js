/**
 * CainFlow Utility Module
 * Contains pure helper functions and independent processing logic.
 */

export function generateId() {
    return 'n_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Show a toast notification
 * @param {string} message 
 * @param {string} type 'success' | 'error' | 'info' | 'warning'
 * @param {number} duration 
 * @param {HTMLElement} container Optional container override
 */
export function showToast(message, type = 'info', duration = 3000, container = document.getElementById('toast-container')) {
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toast-out 0.3s ease-out forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

export function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export function compareVersions(v1, v2) {
    const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
    const a = parse(v1);
    const b = parse(v2);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const numA = a[i] || 0;
        const numB = b[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

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

export function dataURLtoBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    return new Blob([u8arr], { type: mime });
}

export function sanitizeDetails(details) {
    if (!details) return null;
    if (typeof details === 'string' && details.length > 1200) {
        return details.substring(0, 1200) + '... [数据过长已截断]';
    }
    if (typeof details === 'object') {
        try {
            const copy = JSON.parse(JSON.stringify(details));
            const traverse = (obj) => {
                for (const key in obj) {
                    if (typeof obj[key] === 'string') {
                        if (obj[key].startsWith('data:image/') && obj[key].length > 500) {
                             obj[key] = '[图片数据已隐藏]';
                        } else if (obj[key].length > 400) {
                             obj[key] = obj[key].substring(0, 400) + '... [数据过长已截断]';
                        }
                    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                        traverse(obj[key]);
                    }
                }
            };
            traverse(copy);
            return JSON.stringify(copy, null, 2);
        } catch (e) { return '[无法序列化的详细信息]'; }
    }
    return details;
}

export function checkLineIntersection(p1, p2, p3, p4) {
    const den = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
    if (den === 0) return null;
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / den;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / den;
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
        return { x: p1.x + ua * (p2.x - p1.x), y: p1.y + ua * (p2.y - p1.y) };
    }
    return null;
}

export function copyToClipboard(text) {
    return navigator.clipboard.writeText(text).then(() => {
        showToast('已复制到剪贴板', 'success');
    }).catch(err => {
        console.error('Copy failed:', err);
        showToast('复制失败', 'error');
    });
}

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

export function hsbToHex(h, s, b) {
    b /= 100; s /= 100;
    let k = n => (n + h / 60) % 6;
    let f = n => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    let toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
}
