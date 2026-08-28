function readPixels(value) {
    const parsed = parseFloat(value || '0');
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function getMeasurementHeight(element, getStyle) {
    const style = getStyle(element);
    const minHeight = readPixels(style?.minHeight);
    if (element?.classList?.contains?.('chat-response-area')) {
        return Math.max(120, minHeight);
    }
    if (element?.tagName === 'TEXTAREA') {
        return Math.max(60, minHeight);
    }
    return 0;
}

/**
 * Temporarily removes user/distributed growth from flexible content while the
 * node's structural minimum is measured. The original inline sizes are restored.
 */
export function withMinimumMeasurementHeights(elements, measure, getStyle = getComputedStyle) {
    const snapshots = [];
    for (const element of Array.from(elements || [])) {
        const height = getMeasurementHeight(element, getStyle);
        if (!element?.style || height <= 0) continue;
        snapshots.push({ element, height: element.style.height });
        element.style.height = `${Math.round(height)}px`;
    }
    try {
        return measure();
    } finally {
        snapshots.forEach(({ element, height }) => {
            element.style.height = height;
        });
    }
}
