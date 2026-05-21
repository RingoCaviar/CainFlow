/**
 * 执行链路里的图片/文本输入输出归一化工具。
 */
export function normalizeImageList(value) {
    if (typeof value === 'string') {
        return value.trim() ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => normalizeImageList(item));
    }
    if (value && typeof value === 'object') {
        return normalizeImageList(
            value.images ??
            value.image ??
            value.dataUrl ??
            value.url ??
            []
        );
    }
    return [];
}

export function normalizeTextList(value) {
    if (typeof value === 'string') {
        return value ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => normalizeTextList(item));
    }
    if (value && typeof value === 'object') {
        return normalizeTextList(
            value.texts ??
            value.text ??
            value.content ??
            value.message ??
            []
        );
    }
    return [];
}

export function getPrimaryImageInput(value) {
    return normalizeImageList(value)[0] || '';
}

export function getLastImageInput(value) {
    const images = normalizeImageList(value);
    return images.length > 0 ? images[images.length - 1] : '';
}

export function getPrimaryTextInput(value) {
    return normalizeTextList(value)[0] || '';
}

export function getTextInputList(value) {
    return normalizeTextList(value);
}
