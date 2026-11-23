import { getOpenAiImageCapabilities, OPENAI_GIF_FRAME_PARAMETERS } from './openai-image-capabilities.js';
import { getOpenAiReferenceImages } from './provider-request-utils.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_MARKUP_PIXELS = 16_777_216;

async function validateMarkupImage(blob) {
    if (blob.type.toLowerCase() !== 'image/png') throw new Error('OpenAI 标注图层必须是透明 PNG 图片。');
    if (blob.size > 50 * 1024 * 1024) throw new Error('OpenAI 标注图层不能超过 50 MB。');
    const header = await blob.slice(0, 33).arrayBuffer();
    const bytes = new Uint8Array(header);
    const fields = new DataView(header);
    if (bytes.length < 33 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
        || fields.getUint32(8) !== 13 || fields.getUint32(12) !== 0x49484452) {
        throw new Error('OpenAI 标注图层必须是有效的 PNG 图片。');
    }
    const width = fields.getUint32(16);
    const height = fields.getUint32(20);
    if (!width || !height || width * height > MAX_MARKUP_PIXELS) {
        throw new Error('OpenAI 标注图层的像素数必须在 1 至 16,777,216 之间。');
    }
}

function imageFileExtension(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return 'png';
}

export function getOpenAiImageEditFields(requestBody, modelId) {
    const fields = ['model', 'prompt', 'n', 'size', 'quality', 'moderation', 'background'];
    if (getOpenAiImageCapabilities(modelId)) {
        fields.push('output_format', 'output_compression', 'input_fidelity', 'response_format', 'complexity', 'safety_identifier', 'user', ...Object.keys(OPENAI_GIF_FRAME_PARAMETERS));
    }
    return Object.fromEntries(fields.filter(key => requestBody[key] !== undefined && requestBody[key] !== null && requestBody[key] !== '')
        .map(key => [key, requestBody[key]]));
}

export async function buildOpenAiImageEditFormData(requestBody, inputs, modelId, readImage) {
    const formData = new FormData();
    const referenceImages = getOpenAiReferenceImages(inputs);
    const imageField = referenceImages.length > 1 ? 'image[]' : 'image';
    for (const [field, value] of Object.entries(getOpenAiImageEditFields(requestBody, modelId))) formData.append(field, String(value));

    for (const [index, value] of referenceImages.entries()) {
        const blob = await readImage(value);
        if (blob.type === 'image/svg+xml' || (blob.type === 'image/gif' && getOpenAiImageCapabilities(modelId)?.outputFormats.includes('gif'))) {
            throw new Error('OpenAI 图片编辑的参考图须为静态 PNG、JPEG 或 WebP。');
        }
        formData.append(imageField, blob, `reference_${index + 1}.${imageFileExtension(blob.type)}`);
    }
    if (requestBody.mask?.data) {
        const blob = await readImage(requestBody.mask.data);
        if (blob.type && blob.type.toLowerCase() !== 'image/png') throw new Error('OpenAI 图片编辑遮罩必须是 PNG 图片');
        if (blob.size > 4 * 1024 * 1024) throw new Error('OpenAI 图片编辑遮罩不能超过 4MB');
        formData.append('mask', blob, requestBody.mask.name || 'mask.png');
    }
    if (requestBody.markup?.data) {
        const blob = await readImage(requestBody.markup.data);
        await validateMarkupImage(blob);
        formData.append('markup', blob, requestBody.markup.name || 'markup.png');
    }
    return formData;
}
