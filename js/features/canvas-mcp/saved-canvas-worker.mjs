import { createInterface } from 'node:readline';
import { Console } from 'node:console';

// Standard output is reserved for the private protocol with the local service.
globalThis.console = new Console(process.stderr);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map();
const nodeAbortControllers = new Map();
const abort = new AbortController();
const stagedOwners = new Map();
let nextId = 0;

function nodeAbortController(nodeId) {
    if (!nodeAbortControllers.has(nodeId)) nodeAbortControllers.set(nodeId, new AbortController());
    return nodeAbortControllers.get(nodeId);
}

function projectRunResults(result) {
    let retained = 0;
    return { ...result, nodeResults: result.nodeResults.map(row => {
        const images = (row.images || []).map((image, index) => {
            if (row.mediaAssetKeys?.[index] || typeof image !== 'string' || retained + image.length > 12_000_000) return null;
            retained += image.length;
            return image;
        });
        return { ...row, images };
    }) };
}

async function rpc(method, args) {
    const id = ++nextId;
    const value = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method, args });
    });
    if (method === 'stageMedia') {
        const owners = stagedOwners.get(args.nodeId) || [];
        stagedOwners.set(args.nodeId, [...owners, { ownerId: value.ownerId, assetKeys: value.assetKeys }]);
    }
    return value;
}

async function readReplies() {
    for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.stop === true) {
            abort.abort();
            continue;
        }
        if (Array.isArray(message.stopNodes)) {
            for (const id of message.stopNodes) nodeAbortController(id).abort();
            continue;
        }
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.errorCode }));
        else request.resolve(message.result);
    }
    abort.abort();
    for (const request of pending.values()) request.reject(new Error('本地服务连接已经关闭'));
}

async function requestProvider({ url, method, headers, body, signal }) {
    signal?.throwIfAborted();
    const request = new Request(url, { method, headers, body });
    const encoded = request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null;
    signal?.throwIfAborted();
    let onAbort;
    const requestResult = rpc('requestProvider', { url, method: request.method, headers: Object.fromEntries(request.headers), body: encoded });
    const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
    let result;
    try { result = await Promise.race([requestResult, cancelled]); }
    finally { signal?.removeEventListener('abort', onAbort); }
    signal?.throwIfAborted();
    return new Response([204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64'), {
        status: result.status, headers: result.headers
    });
}

async function main() {
    const command = JSON.parse((await lines.next()).value);
    void readReplies().catch(() => abort.abort());
    const [{ loadBuiltInProtocols }, { collectWorkflowMediaOwnerLists }] = await Promise.all([
        import('../execution/protocols/index.js'), import('../media/workflow-media-ownership-commit.js')
    ]);
    await loadBuiltInProtocols(command.protocolOverrides);
    let response;
    if (command.method === 'execute') {
        const { executeSavedWorkflow } = await import('./saved-canvas-execution.js');
        const { document, ...result } = await executeSavedWorkflow({
            ...command, ...command.args, signal: abort.signal, getNodeSignal: id => nodeAbortController(id).signal,
            isNodeStopped: id => nodeAbortController(id).signal.aborted,
            loadMedia: assetKey => rpc('loadMedia', { assetKey }),
            loadFileText: (nodeId, referenceId) => rpc('loadFileText', { nodeId, referenceId }),
            loadFileValue: (nodeId, referenceId, kind) => rpc('loadFileText', { nodeId, referenceId, kind }),
            getHistoryEntry: async (id, { fileVersion }) => {
                const { mimeType, body } = await rpc('historyMedia', { id: Number(id), fileVersion });
                return { fileVersion, image: `data:${mimeType};base64,${body}` };
            },
            saveMedia: async (dataUrl, nodeId) => (await rpc('stageMedia', { dataUrl, nodeId })).assetKeys[0],
            requestProvider
        });
        response = { result: projectRunResults(result), document };
    } else if (command.method === 'owner_lists') {
        response = { result: {}, document: command.document };
    } else {
        const { createSavedCanvasDocument } = await import('./saved-canvas-document.js');
        response = await createSavedCanvasDocument({ ...command, rpc }).dispatch(command.method, command.args);
        if (command.method === 'read_canvas') {
            const { SAVED_EXECUTABLE_TYPES } = await import('./saved-canvas-execution.js');
            response.result.runnableTypes = SAVED_EXECUTABLE_TYPES;
        }
        if (command.method === 'validate_run') {
            const { planSavedWorkflowExecution } = await import('./saved-canvas-execution.js');
            const { enabledNodeIds } = planSavedWorkflowExecution({ document: command.document, ...command.args });
            response.result.nodeIds = enabledNodeIds;
        }
    }
    if (response.document) {
        const ownerLists = collectWorkflowMediaOwnerLists(response.document);
        const referencedAssets = new Map(ownerLists.filter(owner => owner.ownerType !== 'prompt-agent-result')
            .map(owner => [owner.ownerId, new Set(owner.assetKeys)]));
        const publishedOwnerIds = [];
        for (const node of response.document.nodes) {
            const referenced = referencedAssets.get(node.id);
            const owners = (stagedOwners.get(node.id) || []).filter(owner => owner.assetKeys.every(key => referenced?.has(key)));
            if (!owners.length) continue;
            node.data = { ...node.data,
                mediaOwnershipTemporaryOwners: [...(node.data?.mediaOwnershipTemporaryOwners || []), ...owners] };
            publishedOwnerIds.push(...owners.map(owner => owner.ownerId));
        }
        response.ownerLists = ownerLists;
        response.publishedOwnerIds = publishedOwnerIds;
    }
    send({ response });
}

try {
    await main();
} catch (error) {
    send({ error: typeof error?.message === 'string' ? error.message.slice(0, 500) : '执行工作流失败',
        errorCode: typeof error?.code === 'string' ? error.code : 'command_failed' });
} finally {
    input.close();
    process.stdin.pause();
}
