/**
 * 定义图片导入节点的元数据、端口配置与默认尺寸。
 */
export const imageImportNode = {
    type: 'ImageImport',
    title: '图片导入',
    cssClass: 'node-import',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    inputs: [],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
    defaultWidth: 240
};
/**
 * 定义图片导入节点的元数据、端口和默认尺寸。
 */
