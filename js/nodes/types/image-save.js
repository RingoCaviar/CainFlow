/**
 * 定义图片保存节点的元数据、端口配置与默认尺寸。
 */
export const imageSaveNode = {
    type: 'ImageSave',
    title: '图片保存',
    cssClass: 'node-save',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '图片输入' }],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    defaultWidth: 240,
    defaultHeight: 300
};
/**
 * 定义图片保存节点的元数据、端口和默认尺寸。
 */
