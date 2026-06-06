/**
 * 提供跨模块复用的基础工具函数，例如 ID 生成与防抖包装。
 */
export function generateId() {
    return 'n_' + Math.random().toString(36).substr(2, 9);
}

export function debounce(fn, ms, setTimeoutRef = setTimeout, clearTimeoutRef = clearTimeout) {
    let timer;
    return (...args) => {
        clearTimeoutRef(timer);
        timer = setTimeoutRef(() => fn(...args), ms);
    };
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeTextSplitDelimiter(delimiter) {
    return String(delimiter ?? '')
        .replace(/\\r\\n/g, '\r\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
}

export function splitTextForTextSplitNode(text, delimiter, options = {}) {
    const source = String(text || '');
    const separator = normalizeTextSplitDelimiter(delimiter);
    const removeEmptyLines = options.removeEmptyLines === true;
    const parts = !source
        ? []
        : (!separator ? [source] : source.split(separator));

    if (!removeEmptyLines) return parts;

    return parts
        .map((part) => String(part || '')
            .split(/\r\n|\r|\n/)
            .filter((line) => line.trim().length > 0)
            .join('\n'))
        .filter((part) => part.trim().length > 0);
}

function releaseElementImageSources(root) {
    if (!root?.querySelectorAll) return;
    const images = root.matches?.('img')
        ? [root, ...Array.from(root.querySelectorAll('img'))]
        : Array.from(root.querySelectorAll('img'));
    images.forEach((img) => {
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        img.onload = null;
        img.onerror = null;
    });
}

export function cleanupElementResources(root) {
    if (!root) return;
    const elements = root.querySelectorAll
        ? [root, ...Array.from(root.querySelectorAll('*'))]
        : [root];
    elements.forEach((element) => {
        if (Array.isArray(element._cleanupFns)) {
            element._cleanupFns.forEach((cleanup) => {
                if (typeof cleanup === 'function') cleanup();
            });
            element._cleanupFns = [];
        }
    });
    releaseElementImageSources(root);
}
