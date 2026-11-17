export const visualStyleNode = {
    type: 'VisualStyle', title: '画面风格', cssClass: 'node-visual-style',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '风格参考图' }],
    outputs: [{ name: 'style', type: 'style', label: '画面风格' }],
    defaultWidth: 280, minWidth: 220, defaultHeight: 160, minHeight: 120
};
