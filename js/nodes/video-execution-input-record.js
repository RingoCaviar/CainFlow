import {
    getProjectedInputValidationReason,
    resolveGenerationInputProjection,
    validateProjectedInputConnections
} from './generation-input-projection.js';

function copyAndFreeze(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(copyAndFreeze));
    // Media values (Blob, File, asset handles) are opaque values owned by their
    // media abstraction. Rebuilding them as object literals loses their
    // prototype and payload; the record snapshots the enclosing shape instead.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyAndFreeze(item)])));
}

function diagnostic(code, details = {}) {
    return { code, details };
}

function hasValue(value) {
    return Array.isArray(value) ? value.some(hasValue) : value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Builds the DOM-free, immutable execution input record for a video node.
 * Connection order must already be the explicit workflow order.
 */
export function resolveVideoExecutionInputRecord({ protocol, modelId, taskType = 'video', inputs = {}, connections = [], prompt = '', controls = {}, selection = {} } = {}) {
    const currentProjection = resolveGenerationInputProjection({ protocol, modelId, taskType });
    const diagnostics = [];
    if (currentProjection?.blockedReason) {
        diagnostics.push(diagnostic('projection-blocked'));
    }
    const connectionValidation = validateProjectedInputConnections(currentProjection, connections);
    if (!connectionValidation.valid) {
        diagnostics.push(diagnostic(
            connectionValidation.inactivePorts.length ? 'inactive-connection' : 'excess-connection',
            connectionValidation
        ));
    }
    const promptPortIds = new Set(currentProjection?.promptPortIds || ['prompt']);
    const connectedPromptValue = [...promptPortIds].map((portId) => inputs[portId]).find(hasValue);
    const connectedPrompt = hasValue(connectedPromptValue);
    const normalizedPrompt = String(prompt || '').trim();
    if (!connectedPrompt && !normalizedPrompt) {
        diagnostics.push(diagnostic('missing-prompt'));
    }
    const imagePorts = new Set((currentProjection?.ports || []).filter((port) => port.type === 'image').map((port) => port.id));
    const unloadedPorts = connections
        .map((connection) => connection?.to?.port)
        .filter((portId) => imagePorts.has(portId) && !hasValue(inputs[portId]));
    if (unloadedPorts.length) {
        diagnostics.push(diagnostic('unloaded-reference-image', {
            ports: [...new Set(unloadedPorts)]
        }));
    }
    const resolvedPrompt = connectedPrompt ? String(Array.isArray(connectedPromptValue) ? connectedPromptValue[0] : connectedPromptValue).trim() : normalizedPrompt;
    const executionInputs = { ...inputs, prompt: resolvedPrompt };
    const immutableInputs = Object.fromEntries(Object.entries(executionInputs).map(([key, value]) => [
        key,
        copyAndFreeze(value)
    ]));
    const record = {
        inputs: immutableInputs,
        prompt: resolvedPrompt,
        projection: copyAndFreeze(currentProjection || {}),
        controls: copyAndFreeze(controls),
        selection: copyAndFreeze(selection),
        diagnostics: copyAndFreeze(diagnostics),
        valid: diagnostics.length === 0
    };
    Object.freeze(immutableInputs);
    return Object.freeze(record);
}
