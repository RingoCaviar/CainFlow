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
