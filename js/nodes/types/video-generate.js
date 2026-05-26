/**
 * 定义视频生成节点的元数据、端口配置与默认尺寸。
 */
export const videoGenerateNode = {
    type: 'VideoGenerate',
    title: '视频生成',
    cssClass: 'node-generate node-video-generate',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>',
    inputs: [
        { name: 'prompt', type: 'text', label: '提示词输入' },
        { name: 'image_1', type: 'image', label: '首帧' },
        { name: 'image_2', type: 'image', label: '尾帧' },
        { name: 'image_3', type: 'image', label: '参考图 1' },
        { name: 'image_4', type: 'image', label: '参考图 2' },
        { name: 'image_5', type: 'image', label: '参考图 3' },
        { name: 'params', type: 'params', label: '自定义参数' }
    ],
    outputs: [{ name: 'video', type: 'video', label: '视频输出' }],
    defaultWidth: 340,
    defaultHeight: 520
};
