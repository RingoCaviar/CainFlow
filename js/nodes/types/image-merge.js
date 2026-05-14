/**
 * Defines the multi-image merge node metadata, ports and default size.
 */
export const imageMergeNode = {
    type: 'ImageMerge',
    title: '多图合一',
    cssClass: 'node-image-merge',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17h7"/><path d="M17.5 13.5v7"/></svg>',
    inputs: [{ name: 'image_1', type: 'image', label: '图片 1' }],
    outputs: [{ name: 'image', type: 'image', label: '多图输出' }],
    defaultWidth: 260,
    defaultHeight: 210
};
