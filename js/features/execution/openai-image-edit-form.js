import { getOpenAiImageCapabilities } from './openai-image-capabilities.js';
import { getOpenAiReferenceImages } from './provider-request-utils.js';

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
        fields.push('output_format', 'output_compression', 'input_fidelity', 'response_format', 'complexity', 'safety_identifier', 'user');
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
        formData.append(imageField, blob, `reference_${index + 1}.${imageFileExtension(blob.type)}`);
    }
    if (requestBody.mask?.data) {
        const blob = await readImage(requestBody.mask.data);
        if (blob.type && blob.type.toLowerCase() !== 'image/png') throw new Error('OpenAI 图片编辑遮罩必须是 PNG 图片');
        if (blob.size > 4 * 1024 * 1024) throw new Error('OpenAI 图片编辑遮罩不能超过 4MB');
        formData.append('mask', blob, requestBody.mask.name || 'mask.png');
    }
    return formData;
}
