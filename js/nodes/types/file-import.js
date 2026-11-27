export const fileImportNode = {
    type: 'FileImport',
    title: '文件导入',
    cssClass: 'node-text node-file-import',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></svg>',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', label: '文本输出' }],
    defaultWidth: 280,
    defaultHeight: 200
};
