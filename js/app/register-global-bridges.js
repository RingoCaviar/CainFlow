/**
 * 收口少量仍需要暴露到 `window` 的兼容桥接。
 */
export function registerGlobalBridges({
    windowRef = window,
    closeModal,
    showLogDetail,
    createCanvasStressTestNodes,
    enableCanvasStressTest = false,
    sampleCanvasPerformance,
    enableCanvasPerformanceMonitor = false
} = {}) {
    if (typeof closeModal === 'function') {
        windowRef.closeModal = closeModal;
    }

    if (typeof showLogDetail === 'function') {
        windowRef.showLogDetail = showLogDetail;
    }

    if (enableCanvasStressTest && typeof createCanvasStressTestNodes === 'function') {
        windowRef.createCanvasStressTestNodes = createCanvasStressTestNodes;
    }
    if (enableCanvasPerformanceMonitor && typeof sampleCanvasPerformance === 'function') {
        windowRef.sampleCanvasPerformance = sampleCanvasPerformance;
    }
}
