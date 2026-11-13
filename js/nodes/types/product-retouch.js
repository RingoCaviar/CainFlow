export const productRetouchNode = {
    type: 'ProductRetouch',
    title: '产品精修',
    cssClass: 'node-product-retouch',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6m-3-3h6m4 8v4m-2-2h4M5 20l2-5L17 5l2 2L9 17l-4 3Zm7-10 2 2"/></svg>',
    inputs: [{ name: 'image', type: 'image', label: '商品参考图' }],
    outputs: [{ name: 'image', type: 'image', label: '精修结果' }],
    capabilities: ['imageResult', 'canonicalImages', 'recoverableImageAsset', 'imageRestore'],
    defaultWidth: 310,
    minWidth: 230,
    maxWidth: 720,
    defaultHeight: 60,
    minHeight: 60,
    contentSized: true
};
