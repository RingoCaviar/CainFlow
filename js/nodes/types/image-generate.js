/**
 * 定义图片生成节点的元数据、端口配置与默认尺寸。
 */
export const imageGenerateNode = {
    type: 'ImageGenerate',
    title: '图片生成 (Gemini)',
    cssClass: 'node-generate',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    inputs: [
        { name: 'prompt', type: 'text', label: '提示词输入' },
        { name: 'image_1', type: 'image', label: '参考图 1' },
        { name: 'image_2', type: 'image', label: '参考图 2' },
        { name: 'image_3', type: 'image', label: '参考图 3' },
        { name: 'image_4', type: 'image', label: '参考图 4' },
        { name: 'image_5', type: 'image', label: '参考图 5' }
    ],
    outputs: [{ name: 'image', type: 'image', label: '图片输出' }]
};
/**
 * 定义图片生成节点的元数据、端口和默认尺寸。
 */
