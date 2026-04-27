/**
 * Defines the image compare node metadata, ports and default size.
 */
export const imageCompareNode = {
    type: 'ImageCompare',
    title: '图片对比',
    cssClass: 'node-image-compare',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/><path d="M7 9h2"/><path d="M15 15h2"/></svg>',
    inputs: [
        { name: 'imageA', type: 'image', label: 'A' },
        { name: 'imageB', type: 'image', label: 'B' }
    ],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    defaultWidth: 280,
    defaultHeight: 340
};
