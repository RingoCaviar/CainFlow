/**
 * 定义复位颜色节点的元数据、端口配置与默认尺寸。
 */
export const colorResetNode = {
    type: 'ColorReset',
    title: '复位颜色',
    cssClass: 'node-color-reset',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 12 19 7"/><path d="M12 12 5 17"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '图片输入' }],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    capabilities: ['imageResult', 'recoverableImageAsset', 'imageRestore', 'inlineImageData', 'nodeIdImageAsset', 'previewThumbnailRestore'],
    defaultWidth: 300,
    defaultHeight: 650
};
