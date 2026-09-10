export function createNodeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {} },
        dataset: {},
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 240 })
    };
}
