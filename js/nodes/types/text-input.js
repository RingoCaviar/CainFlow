import { textNode } from './text.js';

// Compatibility shim for stale cached module graphs and legacy workflow code.
export const textInputNode = {
    ...textNode,
    type: 'TextInput',
    title: '文本输入',
    cssClass: 'node-text-in',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', label: '文本输出' }]
};
