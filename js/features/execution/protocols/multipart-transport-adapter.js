/**
 * 将声明式 multipart 字段转换为浏览器可发送的 FormData。
 * Data URL 会变成 Blob；远程 URL 保持字符串，让上游 adapter 决定是否
 * 需要先上传或让供应商自行抓取。fields 的顺序会原样保留。
 */
export function buildMultipartFormData(fields = []) {
    const formData = new FormData();
    for (const [field, value] of fields) {
        const dataMatch = typeof value === 'string' && value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
        if (!dataMatch) {
            formData.append(field, String(value));
            continue;
        }
        const bytes = Uint8Array.from(atob(dataMatch[2]), (character) => character.charCodeAt(0));
        const mimeType = dataMatch[1];
        const extension = mimeType.split('/')[1]?.split('+')[0] || 'bin';
        formData.append(field, new Blob([bytes], { type: mimeType }), `reference.${extension}`);
    }
    return formData;
}
