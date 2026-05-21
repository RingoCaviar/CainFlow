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

export function splitTextForTextSplitNode(text, delimiter, options = {}) {
    const source = String(text || '');
    const separator = String(delimiter || '');
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
