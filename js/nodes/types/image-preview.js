/**
 * 定义图片预览节点的元数据、端口配置与默认尺寸。
 */
export const imagePreviewNode = {
    type: 'ImagePreview',
    title: '图片预览',
    cssClass: 'node-preview',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '图片输入' }],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    defaultWidth: 240,
    defaultHeight: 300
};
/**
 * 定义图片预览节点的元数据、端口和默认尺寸。
 */
