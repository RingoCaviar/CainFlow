/**
 * Defines the text split node metadata, ports and default size.
 */
export const textSplitNode = {
    type: 'TextSplit',
    title: '多行文本分割',
    cssClass: 'node-text node-text-split',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h16"/><path d="M18 10l3 3-3 3"/></svg>',
    inputs: [{ name: 'text', type: 'text', label: '文本输入' }],
    outputs: [{ name: 'part_1', type: 'text', label: '片段 1' }],
    defaultWidth: 320,
    defaultHeight: 330
};
