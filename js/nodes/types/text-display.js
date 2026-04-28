import { textNode } from './text.js';

// Compatibility shim for stale cached module graphs and legacy workflow code.
export const textDisplayNode = {
    ...textNode,
    type: 'TextDisplay',
    title: '文本显示',
    cssClass: 'node-text-out',
    inputs: [{ name: 'text', type: 'text', label: '文本输入' }],
    outputs: []
};
