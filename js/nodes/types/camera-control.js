export const cameraControlNode = {
    type: 'CameraControl',
    title: '视角控制',
    cssClass: 'node-camera-control',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><path d="M8 10l4 2-4 2z"/></svg>',
    inputs: [
        { name: 'image', type: 'image', label: '参考图像' }
    ],
    outputs: [
        { name: 'text', type: 'text', label: '相机提示词' }
    ],
    defaultWidth: 300,
    defaultHeight: 356,
    minHeight: 320
};
