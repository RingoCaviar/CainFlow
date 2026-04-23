/**
 * 定义文本输入节点的元数据、端口配置与默认尺寸。
 */
export const textInputNode = {
    type: 'TextInput',
    title: '文本输入',
    cssClass: 'node-text-in',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', label: '文本输出' }],
    defaultWidth: 260,
    defaultHeight: 180
};
/**
 * 定义文本输入节点的元数据、端口和默认尺寸。
 */
