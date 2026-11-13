import { readImageGenerationSettings } from './image-generation-settings.js';
import { renderImageNodeRunState } from './image-node-run-state.js';
import { getImageImportMediaAssetReferences, getPrimaryTextInput, getTextInputList } from '../features/execution/execution-data-utils.js';
import { orderImageReferenceConnections } from './image-reference-projection.js';
import { getEffectiveProtocol, getResolvedProviderForModel } from '../features/execution/provider-request-utils.js';
import { getProtocol } from '../features/execution/protocols/index.js';
import { resolveDeclarativeProtocolVariant } from '../features/execution/protocols/declarative-protocol-schema.js';
import { getImageDescription } from '../features/execution/reference-image-description.js';
import { resolveImageRequestSize } from '../features/execution/image-generation-size.js';
import { getOpenAiImageCapabilities } from '../features/execution/openai-image-capabilities.js';
import { getGoogleImageCapabilities } from '../features/execution/google-image-capabilities.js';
import { resolveThinking, getThinkingCapability, normalizeThinkingSelection } from '../features/execution/thinking-config.js';
import { findPromptImageMentions } from './prompt-image-mentions.js';

const PROTOCOL_PRESENTATION_FIELDS = new Set(['id', 'name', 'label', 'helpText', 'description', 'note', 'videoMeta',
    'schemaVersion', 'baseSchemaVersion', 'baseRevision', 'overrideRevision', 'overrideRecord', 'executionSnapshot',
    'variants', 'variantId', 'variantIdCaseInsensitive']);
const PARAMETER_PRESENTATION_FIELDS = new Set(['name', 'label', 'exposed', 'uiControl', 'portLabel', 'note', 'description', 'placeholder', 'rows', 'layout']);
const OPENAI_ADVANCED_FIELDS = new Set(['output_format', 'output_compression', 'input_fidelity', 'style', 'response_format', 'complexity']);

function protocolWireConfiguration(configuration) {
    if (!configuration) return null;
    const projectParameter = definition => definition && Object.fromEntries(Object.entries(definition)
        .filter(([key]) => !PARAMETER_PRESENTATION_FIELDS.has(key))
        .map(([key, value]) => [key, key === 'options' && Array.isArray(value)
            ? value.map(option => option && typeof option === 'object' ? Object.fromEntries(Object.entries(option)
                .filter(([field]) => !PARAMETER_PRESENTATION_FIELDS.has(field))) : option) : value]));
    return Object.fromEntries(Object.entries(configuration)
        .filter(([key, value]) => !PROTOCOL_PRESENTATION_FIELDS.has(key) && typeof value !== 'function')
        // Parameter order can concatenate values into the same request field.
        // Strip presentation at this schema level, never inside wire values.
        .map(([key, value]) => [key, key === 'parameters' ? Object.entries(value || {})
            .filter(([id, definition]) => (configuration.id !== 'openai' || !OPENAI_ADVANCED_FIELDS.has(id))
                && (!definition?.taskTypes || definition.taskTypes.includes('image')))
            .map(([id, definition]) => [id, projectParameter(definition)]) : value]));
}

function thinkingWireConfiguration(model, provider, protocol, selection) {
    const options = { model: model || {}, provider: provider || {}, protocol, task: 'image' };
    try { return resolveThinking(options, selection).patch; }
    catch {
        const capability = getThinkingCapability(options);
        // Invalid selections still change the execution contract. Their display
        // message contains mutable model/provider names, so retain typed facts.
        return { invalid: true, setting: normalizeThinkingSelection(selection) || normalizeThinkingSelection(model?.thinking?.default) || { mode: 'default' },
            capability: Object.fromEntries(['id', 'supported', 'wire', 'levels', 'min', 'max', 'off', 'on', 'dynamic'].map(key => [key, capability[key]])) };
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined && typeof value[key] !== 'function').map(key => [key, stable(value[key])]));
    return value;
}

function digest(value) {
    const text = JSON.stringify(stable(value));
    let first = 2166136261, second = 2246822519;
    for (let index = 0; index < text.length; index++) {
        first = Math.imul(first ^ text.charCodeAt(index), 16777619);
        second = Math.imul(second ^ text.charCodeAt(index), 3266489917);
    }
    return `gen1-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function readGenerationRevision(value) {
    if (value?.version !== 1 || typeof value.dirty !== 'boolean') return null;
    return { version: 1, dirty: value.dirty,
        ...(/^gen1-[a-f0-9]{16}$/.test(value.successFingerprint || '') ? { successFingerprint: value.successFingerprint } : {}) };
}

/** An edit marker and a digest of a confirmed recipe, never a second parameter or media store. */
export function createImageGenerationRevisionApi({ state, documentRef, getActiveWorkflowId = () => state.activeWorkflowId || '',
    getCachedOutputValue = () => undefined, onChanged = () => {} }) {
    const observed = new WeakMap(), attempts = new WeakMap();
    let serial = 0;
    const referencePort = port => port === 'referenceImages' || port === 'image' || /^image_\d+$/.test(port);
    function compact(value) {
        if (typeof value === 'string' && /^data:(?:image|video)\//i.test(value)) return { inlineMedia: digest(value), length: value.length };
        if (Array.isArray(value)) return value.map(compact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
        return value;
    }
    function captureInputIdentity(connection, value) {
        const source = state.nodes.get(connection.from.nodeId);
        if (source?.enabled === false) return null;
        const identity = { nodeId: connection.from.nodeId, port: connection.from.port, role: connection.to.port };
        if (!source) return { ...identity, missing: true };
        if (connection.from.port === 'image') {
            const data = source.data || {};
            const assets = source.type === 'ImageImport' ? getImageImportMediaAssetReferences(source) : data.mediaAssetKeys || source.mediaAssetKeys || [];
            const count = Math.max(assets.length, Number(data.imageCount) || (assets.length ? 0 : 1));
            const legacy = data.imageAssetKey || source.imageImportAssetKey || data.imageImportAssetKey;
            const remote = source.type === 'ImageImport' && (source.importMode ?? data.importMode) === 'url' ? source.imageUrl || data.imageUrl || '' : '';
            const slots = assets.length ? assets.map((asset, index) => ({ index, asset }))
                : legacy ? Array.from({ length: count }, (_, index) => ({ index, asset: `${legacy}:${index}` })) : [];
            if (referencePort(connection.to.port)) slots.forEach(slot => { slot.description = getImageDescription(source, slot.index); });
            const isMask = connection.to.port === 'mask', consumedSlots = isMask ? slots.slice(0, 1) : slots, consumedCount = isMask ? Math.min(1, count) : count;
            return { ...identity, slots: consumedSlots, count: consumedCount,
                ...(isMask ? { consumption: connection.maskConsumption === 'single' ? 'single' : 'legacy-first' } : {}),
                ...(remote ? { remote, description: getImageDescription(source) } : {}),
                missing: (data.mediaIntegrity?.missingItems || []).map(item => item.position).filter(position => position < consumedCount),
                ready: !!remote || consumedSlots.length >= consumedCount && consumedSlots.every(slot => !!slot.asset) };
        }
        const output = value !== undefined ? value : getCachedOutputValue(source, connection.from.port);
        return { ...identity, value: compact(output) };
    }
    function inputIdentities(node, captured = null) {
        if (captured) return captured.filter(Boolean);
        const incoming = (state.connections || []).filter(edge => edge.to.nodeId === node.id);
        const references = orderImageReferenceConnections(incoming);
        const other = incoming.filter(edge => !referencePort(edge.to.port)).sort((left, right) => left.to.port.localeCompare(right.to.port));
        return [...references, ...other].map(edge => captureInputIdentity(edge)).filter(Boolean);
    }
    function recipe(node, { inputs = null, sources = null } = {}) {
        const settings = readImageGenerationSettings(node, documentRef), identities = inputIdentities(node, sources);
        const fromRole = role => inputs && Object.hasOwn(inputs, role) ? inputs[role] : identities.find(source => source.role === role)?.value;
        const model = (state.models || []).find(model => model.id === settings.apiConfigId);
        const provider = getResolvedProviderForModel(model, state.providers || [], settings.providerId);
        const protocol = getEffectiveProtocol(model || {}, provider), configuration = getProtocol(protocol);
        const effectiveConfiguration = configuration ? resolveDeclarativeProtocolVariant(configuration, model?.modelId || '').configuration : null;
        const parameters = effectiveConfiguration?.parameters || null;
        const openAi = protocol === 'openai' ? getOpenAiImageCapabilities(model?.modelId) : null;
        const protocolParams = Object.fromEntries(Object.entries(settings.protocolParams).filter(([key]) => {
            if (key === 'prompt') return false; // Its upstream-first effective value is recorded below.
            // These optional controls are compiled by the OpenAI image adapter;
            // adding a control with no value doesn't change an existing recipe.
            if (protocol === 'openai' && OPENAI_ADVANCED_FIELDS.has(key) && (!openAi || settings.protocolParams[key] == null || settings.protocolParams[key] === '')) return false;
            const definition = parameters?.[key];
            return !parameters || definition && definition.portOnly !== true && (!definition.taskTypes || definition.taskTypes.includes('image'));
        }));
        let size;
        try { const { resolution, aspect } = resolveImageRequestSize({ protocol, modelId: model?.modelId, ...settings }); size = { resolution, aspect }; }
        catch { size = { resolution: settings.resolution, aspect: settings.aspect, customWidth: settings.customWidth, customHeight: settings.customHeight }; }
        const prompts = (getTextInputList(fromRole('prompt')).length ? getTextInputList(fromRole('prompt')) : [settings.protocolParams.prompt || settings.prompt || '']).map(text => text.trim());
        const cameraPrompt = getPrimaryTextInput(fromRole('camera_prompt')).trim();
        const imageMentions = findPromptImageMentions(node, [...prompts, cameraPrompt, settings.protocolParams.systemPrompt])
            .map(({ token, source }) => ({ token, identity: source.connectionId
                ? [source.connectionId, source.sourceNodeId, source.sourcePort, source.targetPort, source.sourceImageIndex] : source.sourceId || source.id }));
        const values = { model: { id: settings.apiConfigId, modelId: model?.modelId || '', protocol }, provider: provider?.id || settings.providerId,
            prompt: prompts, cameraPrompt, generationCount: settings.generationCount,
            ...(imageMentions.length ? { imageMentions } : {}),
            ...size,
            ...(['openai', 'ttapi-openai'].includes(protocol) ? { quality: settings.quality, moderation: settings.moderation, background: settings.background } : {}),
            ...(['google', 'ttapi'].includes(protocol) ? {
                search: settings.search && (protocol !== 'google' || getGoogleImageCapabilities(model?.modelId)?.search !== false)
            } : {}),
            protocolParams, thinking: thinkingWireConfiguration(model, provider, protocol, node.data?.thinking),
            protocolWire: protocolWireConfiguration(effectiveConfiguration), customParams: compact(fromRole('params')),
            sources: identities.map(source => ['prompt', 'camera_prompt', 'params'].includes(source.role)
                ? Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'value')) : source) };
        // Registry modules can still be loading during editor restoration.
        // An absent contract cannot invalidate a previously confirmed digest.
        return { fingerprint: digest(values), ready: !!configuration && identities.every(source => source.ready !== false) };
    }
    const fingerprint = (node, options) => recipe(node, options).fingerprint;
    function notify(node) { renderImageNodeRunState(node); onChanged(node); }
    function initializeNode(nodeId) {
        const node = state.nodes.get(nodeId);
        if (node?.type !== 'ImageGenerate' || observed.has(node)) return;
        const current = recipe(node), record = readGenerationRevision(node.data?.generationRevision);
        observed.set(node, current.fingerprint);
        // Node bindings are installed before all restored edges exist. The
        // completed-view observation below reconciles the trusted recipe.
        node.generationDirty = record?.dirty === true;
        notify(node);
    }
    function beginAttempt(node, inputs = null, options = {}) {
        if (node?.type !== 'ImageGenerate' || state.nodes.get(node.id) !== node) return null;
        initializeNode(node.id);
        const token = { node, workflowId: getActiveWorkflowId(), runToken: options.runToken || ++serial,
            boundRunToken: options.runToken || null,
            recipe: recipe(node, { inputs, sources: options.sources }) };
        attempts.set(node, token);
        return token;
    }
    function completeAttempt(token, { succeeded = false, partial = false } = {}) {
        if (!token || state.nodes.get(token.node.id) !== token.node || getActiveWorkflowId() !== token.workflowId || attempts.get(token.node) !== token
            || token.boundRunToken && token.node.activeMediaOperationId !== token.boundRunToken) return false;
        attempts.delete(token.node);
        const node = token.node;
        observe(node.id);
        if (!succeeded || partial) return false;
        const current = recipe(node);
        if (!token.recipe.ready || !current.ready || current.fingerprint !== token.recipe.fingerprint) {
            node.data.generationRevision = { ...(readGenerationRevision(node.data.generationRevision) || { version: 1 }), dirty: true };
            if (!node.generationDirty) { node.generationDirty = true; notify(node); }
            return false;
        }
        node.data.generationRevision = { version: 1, dirty: false, successFingerprint: token.recipe.fingerprint };
        node.generationDirty = false;
        observed.set(node, current.fingerprint);
        notify(node);
        return true;
    }
    function observe(nodeId, { initialize = false } = {}) {
        const node = state.nodes.get(nodeId);
        if (node?.type !== 'ImageGenerate') return;
        if (!observed.has(node)) { initializeNode(nodeId); if (!initialize) return; }
        const currentRecipe = recipe(node), current = currentRecipe.fingerprint, previous = observed.get(node);
        observed.set(node, current);
        const record = readGenerationRevision(node.data?.generationRevision);
        // A projected background success can bring a new trusted digest to the
        // existing editor object. Compare it even when no local input changed.
        if (record?.successFingerprint === current && record.dirty === false) return;
        const disagreesWithSuccess = currentRecipe.ready && record?.successFingerprint && record.successFingerprint !== current;
        if (initialize && !disagreesWithSuccess || current === previous && !disagreesWithSuccess) return;
        node.data ||= {};
        node.data.generationRevision = { ...(record || { version: 1 }), dirty: true };
        if (!node.generationDirty) { node.generationDirty = true; notify(node); }
    }
    const observeAll = options => state.nodes.forEach(node => observe(node.id, options));
    return { initializeNode, observeAll, onSettingsChanged: nodeId => observe(nodeId),
        read: node => node?.generationDirty === true, fingerprint, captureInputIdentity, beginAttempt, completeAttempt };
}
