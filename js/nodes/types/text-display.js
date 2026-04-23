/**
 * 定义文本展示节点的元数据、端口配置与默认尺寸。
 */
export const textDisplayNode = {
    type: 'TextDisplay',
    title: '文本显示',
    cssClass: 'node-text-out',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    inputs: [{ name: 'text', type: 'text', label: '文本输入' }],
    outputs: [],
    defaultWidth: 260,
    defaultHeight: 180
};
/**
 * 定义文本显示节点的元数据、端口和默认尺寸。
 */
