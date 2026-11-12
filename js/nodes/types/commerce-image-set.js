export const commerceImageSetNode = {
    type: 'ECommerceImageSet',
    title: '电商套图',
    cssClass: 'node-commerce-image-set',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    inputs: [{ name: 'referenceImages', type: 'image', label: '商品参考图', multiple: true }],
    outputs: [{ name: 'image', type: 'image', label: '套图输出' }],
    capabilities: ['imageResult', 'canonicalImages', 'recoverableImageAsset', 'imageRestore'],
    defaultWidth: 340,
    minWidth: 230,
    maxWidth: 720,
    defaultHeight: 60,
    minHeight: 60,
    contentSized: true
};
