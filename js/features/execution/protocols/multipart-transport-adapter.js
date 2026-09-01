/** 将声明式 multipart 字段转换为浏览器可发送的 FormData。 */
export function buildMultipartFormData(fields = []) {
    const formData = new FormData();
    for (const [field, value] of fields) {
        const imageMatch = typeof value === 'string' && value.match(/^data:(image\/[^;]+);base64,(.+)$/i);
        if (!imageMatch) {
            formData.append(field, String(value));
            continue;
        }
        const bytes = Uint8Array.from(atob(imageMatch[2]), (character) => character.charCodeAt(0));
        const mimeType = imageMatch[1];
        const extension = mimeType.split('/')[1] || 'png';
        formData.append(field, new Blob([bytes], { type: mimeType }), `reference.${extension}`);
    }
    return formData;
}
