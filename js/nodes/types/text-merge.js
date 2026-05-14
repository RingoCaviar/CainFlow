/**
 * Defines the multi-text merge node metadata, ports and default size.
 */
export const textMergeNode = {
    type: 'TextMerge',
    title: '多文本合一',
    cssClass: 'node-text node-text-merge',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h10"/><path d="M4 12h10"/><path d="M4 18h10"/><path d="M18 8v8"/><path d="M14 12h8"/></svg>',
    inputs: [{ name: 'text_1', type: 'text', label: '文本 1' }],
    outputs: [{ name: 'text', type: 'text', label: '多文本输出' }],
    defaultWidth: 260,
    defaultHeight: 210
};
