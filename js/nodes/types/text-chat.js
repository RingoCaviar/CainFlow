/**
 * 定义智能对话节点的元数据、端口配置与默认尺寸。
 */
export const textChatNode = {
    type: 'TextChat',
    title: '智能对话',
    cssClass: 'node-chat',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    inputs: [
        { name: 'prompt', type: 'text', label: '提问输入' },
        { name: 'image_1', type: 'image', label: '参考图 1' },
        { name: 'image_2', type: 'image', label: '参考图 2' },
        { name: 'image_3', type: 'image', label: '参考图 3' },
        { name: 'image_4', type: 'image', label: '参考图 4' },
        { name: 'image_5', type: 'image', label: '参考图 5' },
        { name: 'params', type: 'params', label: '自定义参数' }
    ],
    outputs: [{ name: 'text', type: 'text', label: '回复文本' }],
    defaultWidth: 410,
    minWidth: 360,
    maxWidth: 720,
    defaultHeight: 144,
    minHeight: 144,
    contentSized: true
};

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;

export function formatSystemPromptPreview(prompt) {
    const text = prompt.trim().replace(/\s+/g, ' ');
    if (!text) return '未设置';
    if (!graphemes) return `已设置 · ${Array.from(text).slice(0, 28).join('')}`;
    let count = 0;
    for (const { index } of graphemes.segment(text)) {
        if (count === 28) return `已设置 · ${text.slice(0, index)}`;
        count += 1;
    }
    return `已设置 · ${text}`;
}
/**
 * 定义智能对话节点的元数据、端口和默认尺寸。
 */
