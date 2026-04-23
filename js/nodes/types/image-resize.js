/**
 * 定义图片缩放节点的元数据、端口配置与默认尺寸。
 */
export const imageResizeNode = {
    type: 'ImageResize',
    title: '缩放图片',
    cssClass: 'node-image-resize',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5"/><path d="M20 15v5h-5"/><path d="M4 4l7 7"/><path d="M20 20l-7-7"/><rect x="5" y="11" width="5" height="5" rx="1"/><rect x="14" y="8" width="5" height="5" rx="1"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '图片输入' }],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    defaultWidth: 280,
    defaultHeight: 420
};
/**
 * 定义图片缩放节点的元数据、端口和默认尺寸。
 */
