import { setTimeout as delay } from 'node:timers/promises';
import { getPrimaryImageInput, getPrimaryTextInput } from '../execution/execution-data-utils.js';
import { resolveImageRequestSize } from '../execution/image-generation-size.js';
import { buildOpenAiImageEditFormData } from '../execution/openai-image-edit-form.js';
import {
    buildDoubaoVideoRequest, buildGoogleImageRequest, buildNewApiAsyncImageRequest, buildOpenAiImageRequest, buildOpenAiVideoRequest,
    buildTtapiImageRequest, buildTtapiOpenAiImageRequest, buildUnifiedVideoRequest,
    extractAsyncImageResult, extractAsyncImageStatus, extractAsyncImageTaskId, extractImageResult, getEffectiveProtocol,
    extractVideoResult, extractVideoStatus, extractVideoTaskId, getOpenAiImageContents, getResolvedProviderForModel, resolveProviderUrl
} from '../execution/provider-request-utils.js';
import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { appendReferenceDescriptions } from '../execution/reference-image-description.js';
import { applyThinking } from '../execution/thinking-config.js';
import { getProtocolSnapshot } from '../execution/protocols/index.js';
import { buildMultipartFormData } from '../execution/protocols/multipart-transport-adapter.js';
import { compileVideoProtocol } from '../execution/protocols/video-protocol-compiler.js';
import { buildVisualStylePrompt, resolveVisualStyle } from '../visual-style/visual-style.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { validateUniversalImageInputs } from '../../nodes/universal-input-policy.js';
import { resolveVideoExecutionInputRecord } from '../../nodes/video-execution-input-record.js';

const imageDataPattern = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/i;

export function savedExecutionError(failureCategory) {
    return Object.assign(new Error(failureCategory), { failureCategory });
}

function providerFailure(status) {
    if (status === 401) return savedExecutionError('invalid_api_key');
    if (status === 403) return savedExecutionError('forbidden');
    if (status === 404) return savedExecutionError('model_not_found');
    if (status === 408 || status === 504) return savedExecutionError('timeout');
    if (status === 429) return savedExecutionError('rate_limit');
    return savedExecutionError('provider_request_failed');
}

function modelConfiguration(state, node, taskType) {
    const model = state.models.find(item => item.id === node.data.apiConfigId && (item.taskType || 'chat') === taskType);
    const provider = model && getResolvedProviderForModel(model, state.providers, node.data.providerId);
    if (!provider?.endpoint || !provider?.apikey) throw savedExecutionError('provider_model_mismatch');
    const protocol = getEffectiveProtocol(model, provider);
    return { model, provider, protocol };
}

function headersFor(provider, protocol, json = true) {
    const headers = json ? { 'Content-Type': 'application/json' } : {};
    if (protocol === 'ttapi' || protocol === 'ttapi-openai') headers['TT-API-KEY'] = provider.apikey;
    else if (protocol !== 'google') headers.Authorization = `Bearer ${provider.apikey}`;
    return headers;
}

async function providerResponse(requestProvider, request) {
    if (typeof requestProvider !== 'function') throw savedExecutionError('provider_request_failed');
    let response;
    try {
        response = await requestProvider(request);
    } catch (error) {
        if (request.signal?.aborted) throw error;
        throw savedExecutionError('connection_interrupted');
    }
    if (!response?.ok) throw providerFailure(response?.status);
    return response;
}

async function inlineImage(value, requestProvider, signal, { allowRemote = false } = {}) {
    const match = typeof value === 'string' && value.match(imageDataPattern);
    if (match) return new Blob([Buffer.from(match[2], 'base64')], { type: match[1].toLowerCase() });
    if (!allowRemote || typeof value !== 'string' || !/^https?:\/\//i.test(value)) throw savedExecutionError('input');
    const response = await providerResponse(requestProvider, { url: value, method: 'GET', headers: {}, signal });
    const blob = await response.blob();
    if (!blob.size || !/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(blob.type)) throw savedExecutionError('no_image_in_response');
    return blob;
}

async function waitForAsyncImage(createResult, { model, provider, protocol, requestProvider, signal }) {
    const taskId = extractAsyncImageTaskId(createResult);
    if (!taskId) throw savedExecutionError('no_image_in_response');
    const url = resolveProviderUrl(provider, model, 'image', { action: 'query', imageTaskId: taskId });
    const headers = { ...headersFor(provider, protocol), Accept: 'application/json' };
    for (let attempt = 0; attempt < 180; attempt++) {
        signal?.throwIfAborted();
        const response = await providerResponse(requestProvider, { url, method: 'GET', headers, signal });
        const payload = await response.json();
        const result = extractAsyncImageResult(payload);
        const status = extractAsyncImageStatus(payload);
        if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) throw savedExecutionError('provider_request_failed');
        if (result.url || ['completed', 'succeeded', 'success'].includes(status)) return result;
        await delay(5000, undefined, { signal });
    }
    throw savedExecutionError('timeout');
}

export async function generateSavedImages(node, inputs, { state, signal, requestProvider, resolveMentions, publishImage }) {
    const { model, provider, protocol } = modelConfiguration(state, node, 'image');
    const settings = readImageGenerationSettings(node);
    const style = buildVisualStylePrompt(resolveVisualStyle(state, node.id, inputs), { lettering: true });
    const userPrompt = getPrimaryTextInput(inputs.prompt) || settings.protocolParams.prompt || settings.prompt;
    const combined = [userPrompt, getPrimaryTextInput(inputs.camera_prompt), style].map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
    const promptText = [settings.protocolParams.systemPrompt, appendReferenceDescriptions(combined, state, node.id)]
        .map(value => String(value || '').trim()).filter(Boolean).join('\n');
    const resolved = await resolveMentions(node, inputs, [promptText], { signal });
    const [prompt] = resolved.prompts;
    inputs = resolved.inputs;
    if (!prompt) throw savedExecutionError('input');
    if (validateUniversalImageInputs({ state, node, inputs })) throw savedExecutionError('input');
    const { aspect, resolution } = resolveImageRequestSize({ ...settings, modelId: model.modelId, protocol });
    const asyncImage = protocol === 'newapi-image-async';
    const url = resolveProviderUrl(provider, model, 'image', { inputs, action: asyncImage ? 'create' : undefined });
    const edit = protocol === 'openai' && /\/images\/edits\/?(?:$|[?#])/i.test(url);
    const maskValue = getPrimaryImageInput(inputs.mask);
    const mask = edit && maskValue ? { data: maskValue, name: 'mask.png' } : null;
    const params = { modelCfg: model, prompt, resolution, aspect, inputs, quality: settings.quality,
        moderation: settings.moderation, background: settings.background, searchEnabled: settings.search,
        protocolParams: settings.protocolParams, protocol, url, edit, mask };
    const body = asyncImage ? buildNewApiAsyncImageRequest(params)
        : protocol === 'google' ? buildGoogleImageRequest({ ...params, modelId: model.modelId })
        : protocol === 'ttapi' ? buildTtapiImageRequest(params)
            : protocol === 'ttapi-openai' ? buildTtapiOpenAiImageRequest(params) : buildOpenAiImageRequest(params);
    if (!asyncImage) applyThinking(body, { model, provider, task: 'image', protocol }, node.data.thinking);

    for (let index = 0; index < settings.generationCount; index++) {
        signal?.throwIfAborted();
        const payload = edit
            ? await buildOpenAiImageEditFormData(body, inputs, model.modelId, value => inlineImage(value))
            : JSON.stringify(body);
        const response = await providerResponse(requestProvider, { url, method: 'POST', headers: headersFor(provider, protocol, !edit), body: payload, signal });
        const responseBody = await response.json();
        const result = asyncImage ? await waitForAsyncImage(responseBody, { model, provider, protocol, requestProvider, signal })
            : extractImageResult(provider, responseBody, model, body.output_format);
        let dataUrl = result?.dataUrl;
        if (!dataUrl && result?.url) {
            const image = await inlineImage(result.url, requestProvider, signal, { allowRemote: true });
            dataUrl = `data:${image.type};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
        }
        if (!imageDataPattern.test(dataUrl || '')) throw savedExecutionError('no_image_in_response');
        await publishImage(dataUrl);
    }
}

export async function runSavedConversation(node, inputs, { state, signal, requestProvider, resolveMentions }) {
    const { model, provider, protocol } = modelConfiguration(state, node, 'chat');
    const promptText = appendReferenceDescriptions(getPrimaryTextInput(inputs.prompt) || node.data.prompt || '', state, node.id);
    const resolved = await resolveMentions(node, inputs, [promptText, node.data.sysprompt || ''], { signal });
    const [prompt, systemPrompt] = resolved.prompts;
    inputs = resolved.inputs;
    if (!String(prompt).trim()) throw savedExecutionError('input');
    const plan = createChatRequestPlan({ model, provider, protocol, systemPrompt,
        messages: [{ role: 'user', content: prompt }], thinking: node.data.thinking,
        searchEnabled: node.data.search === true, customParams: inputs.params,
        media: getOpenAiImageContents(inputs).map(item => ({ type: 'image', url: item.image_url.url })) });
    const { text } = await requestChatCompletion(plan, {
        fetchRef: (_path, request) => providerResponse(requestProvider, { ...request, url: plan.url }),
        headers: headersFor(provider, protocol), signal
    });
    return text;
}

async function resolveVideoRequest(node, inputs, { state, model, provider, protocol, signal, resolveMentions }) {
    const declared = getProtocolSnapshot(protocol);
    if (!declared?.taskTypes?.includes('video')) throw savedExecutionError('unsupported_node');
    const {
        prompt: localPrompt, protocolParams = {}, aspect = '16:9', useVideoSizeParam, doubaoResolution = '720p',
        doubaoDuration = '5', doubaoCameraFixed, doubaoGenerateAudio, doubaoWatermark, doubaoSeed = '', enhancePrompt, enableUpsample
    } = node.data;
    const connections = state.connections.filter(edge => edge.to.nodeId === node.id && state.nodes.get(edge.from.nodeId)?.enabled !== false);
    const record = resolveVideoExecutionInputRecord({ protocol: declared, modelId: model.modelId, inputs, connections,
        prompt: protocolParams.prompt || localPrompt || '' });
    if (!record.valid) throw savedExecutionError('input');
    const resolved = await resolveMentions(node, record.inputs,
        [appendReferenceDescriptions(record.prompt, state, node.id), protocolParams.systemPrompt || ''],
        { signal, videoPorts: record.projection.ports });
    const [userPrompt, systemPrompt] = resolved.prompts;
    const prompt = [systemPrompt, userPrompt].filter(Boolean).join('\n');
    const videoInputs = resolved.inputs;
    if (Object.keys(declared.variants || {}).length) {
        const plan = compileVideoProtocol({ protocol: declared, endpoint: provider.endpoint, modelId: model.modelId,
            parameters: { ...protocolParams, prompt }, inputs: videoInputs, apiKey: provider.apikey });
        const body = plan.create.encoding === 'multipart' ? buildMultipartFormData(plan.create.fields) : JSON.stringify(plan.create.body);
        return { plan, prompt, request: { ...plan.create, body } };
    }

    const common = { modelCfg: model, prompt, inputs: videoInputs, aspectRatio: protocolParams.size || protocolParams.aspect_ratio || protocolParams.aspect || aspect,
        useSizeParam: protocolParams.size !== undefined || useVideoSizeParam === true, duration: protocolParams.duration || '', loop: protocolParams.loop === true };
    const body = protocol === 'veo-openai' ? buildOpenAiVideoRequest(common) : protocol === 'doubao-video'
        ? buildDoubaoVideoRequest({ ...common, duration: protocolParams.duration ?? doubaoDuration, resolution: protocolParams.resolution ?? doubaoResolution,
            cameraFixed: protocolParams.camera_fixed ?? doubaoCameraFixed, generateAudio: protocolParams.generate_audio ?? doubaoGenerateAudio,
            watermark: protocolParams.watermark ?? doubaoWatermark, seed: protocolParams.seed ?? doubaoSeed })
        : buildUnifiedVideoRequest({ ...common, enhancePrompt: protocolParams.enhance_prompt ?? enhancePrompt,
            enableUpsample: protocolParams.enable_upsample ?? enableUpsample });
    return { prompt, request: { url: resolveProviderUrl(provider, model, 'video', { action: 'create' }), method: 'POST',
        headers: headersFor(provider, protocol), body: JSON.stringify(body) } };
}

async function waitForVideoResult(id, { model, provider, protocol, requestProvider, signal, plan }) {
    const url = plan ? plan.queryUrl(id) : resolveProviderUrl(provider, model, 'video', { action: 'query', videoId: id });
    const headers = { ...(plan?.create.headers || headersFor(provider, protocol)), Accept: 'application/json' };
    const completed = plan?.asyncTask.completedStatuses || ['completed', 'succeeded', 'success'];
    const failed = plan?.asyncTask.failedStatuses || ['failed', 'error', 'cancelled', 'canceled'];
    for (let attempt = 0; attempt < 180; attempt++) {
        signal?.throwIfAborted();
        let response;
        try { response = await providerResponse(requestProvider, { url, method: 'GET', headers, signal }); }
        catch (error) {
            if (protocol !== 'veo-unified' || error.failureCategory !== 'model_not_found' || attempt >= 4) throw error;
            await delay(10000, undefined, { signal });
            continue;
        }
        const payload = await response.json();
        const status = plan ? plan.parseStatus(payload) : extractVideoStatus(payload, protocol);
        const resultUrl = plan ? plan.parseResultUrl(payload) : extractVideoResult(payload, protocol).url;
        if (failed.includes(status)) throw savedExecutionError('provider_request_failed');
        if (resultUrl) return { url: resultUrl, headers: {} };
        if (completed.includes(status)) {
            if (protocol !== 'veo-openai') throw savedExecutionError('no_video_in_response');
            return { url: resolveProviderUrl(provider, model, 'video', { action: 'download', videoId: id }), headers: headersFor(provider, protocol, false) };
        }
        await delay(10000, undefined, { signal });
    }
    throw savedExecutionError('timeout');
}

export async function generateSavedVideos(node, inputs, { state, signal, requestProvider, resolveMentions, publishVideo }) {
    const { model, provider, protocol } = modelConfiguration(state, node, 'video');
    const { plan, prompt, request } = await resolveVideoRequest(node, inputs, { state, model, provider, protocol, signal, resolveMentions });
    const count = Math.max(1, parseInt(node.data.generationCount, 10) || 1);
    for (let index = 0; index < count; index++) {
        signal?.throwIfAborted();
        const response = await providerResponse(requestProvider, { ...request, signal });
        const creation = await response.json();
        const id = plan ? plan.parseTaskId(creation) : extractVideoTaskId(creation, protocol);
        if (!id) throw savedExecutionError('no_video_in_response');
        const result = await waitForVideoResult(id, { model, provider, protocol, requestProvider, signal, plan });
        const download = await providerResponse(requestProvider, { ...result, method: 'GET', signal });
        const video = await download.blob();
        if (!video.size || !/^video\/[\w.+-]+$/i.test(video.type)) throw savedExecutionError('no_video_in_response');
        const dataUrl = `data:${video.type};base64,${Buffer.from(await video.arrayBuffer()).toString('base64')}`;
        await publishVideo({ dataUrl, id, status: 'completed', prompt });
    }
}
