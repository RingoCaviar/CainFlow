const FILE_OUTPUT_LABELS = { text: '文本输出', image: '图片输出', video: '视频输出', file: '原件输出' };
const IMAGE_DISPLAY_TYPES = new Set(['ImagePreview', 'ImageSave', 'ImageCompare', 'ImageMerge']);
const watchedFiles = new Set();
let watchTimer;

export function fileImportOutput(fileImport) {
    const kind = Object.hasOwn(FILE_OUTPUT_LABELS, fileImport?.kind) ? fileImport.kind : 'text';
    return { name: kind, type: kind, label: FILE_OUTPUT_LABELS[kind] };
}

export function normalizeFileImport(value) {
    if (typeof value?.name !== 'string' || !value.name || /[\\/]/.test(value.name)) return null;
    return {
        name: value.name.slice(0, 255),
        ...(/^[a-f0-9]{32}$/.test(value.id) ? { id: value.id } : {}),
        ...(Object.hasOwn(FILE_OUTPUT_LABELS, value.kind) ? { kind: value.kind } : {}),
        ...(typeof value.mime === 'string' ? { mime: value.mime.slice(0, 150) } : {}),
        ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {})
    };
}

export function projectFileImportForShare(node) {
    if (node?.type !== 'FileImport') return node;
    const fileImport = normalizeFileImport(node.fileImport);
    if (fileImport) delete fileImport.id;
    return { ...node, fileImport };
}

function fileImportUrl(action, workflowId, nodeId, fileImport, version) {
    if (!workflowId || !fileImport?.id) throw new Error('请重新定位原文件。');
    const query = new URLSearchParams({ workflowId, nodeId, referenceId: fileImport.id });
    if (version) query.set('v', version);
    return `/api/storage/file-imports/${action}?${query}`;
}

export function originalFileValue(workflowId, nodeId, fileImport, info) {
    return {
        ...info,
        url: fileImportUrl('content', workflowId, nodeId, fileImport, info.version),
        mimeType: info.mime,
        fileImport: { workflowId, nodeId, id: fileImport.id }
    };
}

async function fileImportResponse(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    if (!response.ok) {
        const result = await response.json();
        throw Object.assign(new Error(result.error || '无法读取原文件。'), { fileImportFailure: true, code: result.code });
    }
    return response;
}

export async function readFileImportText(workflowId, nodeId, fileImport, version) {
    const response = await fileImportResponse(fileImportUrl('text', workflowId, nodeId, fileImport, version));
    const result = await response.json();
    if (typeof result.text !== 'string') {
        throw new Error(result.error || '无法读取原文件。');
    }
    return result.text;
}

export async function readFileImportInfo(workflowId, nodeId, fileImport) {
    return (await fileImportResponse(fileImportUrl('info', workflowId, nodeId, fileImport))).json();
}

export async function readFileImportOutput(workflowId, node, port, toNode, snapshot) {
    const fileImport = node.fileImport ?? node.data?.fileImport;
    if (fileImportOutput(fileImport).name !== port) throw Object.assign(new Error('原文件输出与当前连线不兼容。'), { fileImportFailure: true });
    if (port === 'text') return readFileImportText(workflowId, node.id, fileImport);
    const info = snapshot ?? await readFileImportInfo(workflowId, node.id, fileImport);
    if (info.kind !== port) throw Object.assign(new Error('原文件类型已变化，请检查连线。'), { fileImportFailure: true });
    const url = fileImportUrl('content', workflowId, node.id, fileImport, info.version);
    if (port === 'video' || (port === 'image' && IMAGE_DISPLAY_TYPES.has(toNode?.type))) {
        const access = await fileImportResponse(url, { headers: { Range: 'bytes=0-0' } });
        await access.body?.cancel();
    }
    if (port === 'image') {
        // Display nodes consume the original URL. Provider and processing nodes consume its bytes in memory.
        if (IMAGE_DISPLAY_TYPES.has(toNode?.type)) return url;
        const blob = await (await fileImportResponse(url)).blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    return originalFileValue(workflowId, node.id, fileImport, info);
}

export function createFileImportRunReader(workflowId) {
    const references = new Map();
    const snapshots = new Map(), values = new Map();
    return (node, port, toNode) => {
        if (!references.has(node.id)) references.set(node.id, node.fileImport ?? node.data?.fileImport);
        const reference = references.get(node.id);
        const display = IMAGE_DISPLAY_TYPES.has(toNode?.type);
        const output = JSON.stringify([node.id, port, port === 'image' && display]);
        if (!values.has(output)) values.set(output, Promise.resolve().then(async () => {
            const source = { id: node.id, fileImport: reference };
            if (port === 'text') return readFileImportOutput(workflowId, source, port, toNode);
            if (!snapshots.has(node.id)) snapshots.set(node.id, readFileImportInfo(workflowId, node.id, reference));
            return readFileImportOutput(workflowId, source, port, toNode, await snapshots.get(node.id));
        }).catch(error => { error.fileImportFailure = true; throw error; }));
        return values.get(output);
    };
}

export function findImageFileSource(node, state) {
    const visited = new Set();
    while (['ImagePreview', 'ImageSave', 'ImageCompare'].includes(node?.type) && node.enabled !== false && !visited.has(node.id)) {
        visited.add(node.id);
        const port = node.type === 'ImageCompare' ? 'imageB' : 'image';
        const edge = state.connections.findLast(connection => connection.to.nodeId === node.id
            && connection.to.port === port && state.nodes.get(connection.from.nodeId)?.enabled !== false);
        if (edge?.from.port !== 'image') return null;
        node = state.nodes.get(edge.from.nodeId);
    }
    return node?.type === 'FileImport' && node.enabled !== false && fileImportOutput(node.fileImport ?? node.data?.fileImport).name === 'image' ? node : null;
}

const FORWARDING_NODES = new Set(['Text', 'TextSplit', 'TextMerge', 'ImagePreview', 'ImageSave', 'ImageCompare', 'ImageMerge', 'CustomParams']);
export function hasOriginalFileInput(node, state) {
    if (!node) return false;
    const visited = new Set();
    function check(id) {
        if (visited.has(id)) return false;
        visited.add(id);
        return (state.connections || []).some(edge => {
            if (edge.to.nodeId !== id) return false;
            const source = state.nodes.get(edge.from.nodeId);
            if (!source || source.enabled === false) return false;
            return source.type === 'FileImport' || (FORWARDING_NODES.has(source.type) && check(source.id));
        });
    }
    return check(node.id);
}

export function getFileDerivedInputConnection(node, state, port) {
    const edge = state.connections.findLast(connection => connection.to.nodeId === node.id && connection.to.port === port
        && state.nodes.has(connection.from.nodeId) && state.nodes.get(connection.from.nodeId).enabled !== false);
    const source = edge && state.nodes.get(edge.from.nodeId);
    return source?.type === 'FileImport' || hasOriginalFileInput(source, state) ? edge : null;
}

export function originalFileRequestHeaders(node, state) {
    return hasOriginalFileInput(node, state) ? { 'X-Cainflow-Private-Input': '1' } : {};
}

export function stripOriginalFileCopies(node, data) {
    if (node.type === 'TextSplit' && (node.fileDerivedText || node.fileTextPartCount !== undefined)) {
        data.fileTextPartCount = node.fileDerivedText ? node.data?.parts?.length || 0 : node.fileTextPartCount;
        delete data.parts;
    }
    if (node.fileDerivedText || (node.type === 'TextSplit' && node.fileTextPartCount !== undefined)) {
        delete data.text;
        delete data.texts;
    }
    if (node.data?.imageList?.some(isOriginalFileUrl) || isOriginalFileUrl(node.data?.image) || isOriginalFileUrl(node.compareImageB)) {
        for (const key of ['imageAssetKey', 'imageAssetReady', 'imageCount', 'imagePreviewIndex', 'imageData', 'imageDataList',
            'imagePreviewThumbnail', 'compareImageB', 'imageHydratedAt']) delete data[key];
    }
    if (isOriginalFileUrl(data.compareImageA)) delete data.compareImageA;
    if (isOriginalFileUrl(node.data?.video?.url)) delete data.video;
    if (Array.isArray(data.videos)) data.videos = data.videos.filter(video => !isOriginalFileUrl(video?.url));
    if (isOriginalFileUrl(data.videoUrl)) delete data.videoUrl;
    return data;
}

export function isOriginalFileUrl(value) {
    return typeof value === 'string' && value.startsWith('/api/storage/file-imports/content?');
}

export function bindFileImportNode({ node, getWorkflowId, windowRef, isCurrent, onReplace, onStatus }) {
    const preview = node.el.querySelector('[data-file-import-preview]');
    const image = node.el.querySelector('[data-file-import-image]');
    const video = node.el.querySelector('[data-file-import-video]');
    const details = node.el.querySelector('[data-file-import-details]');
    const status = node.el.querySelector('[data-file-import-status]');
    const open = node.el.querySelector('[data-file-import-open]');
    const replace = node.el.querySelector('[data-file-import-replace]');
    const report = (state, message) => {
        if (!isCurrent()) return;
        node.fileImportStatus = state;
        status.textContent = [message, onStatus?.(state)].filter(Boolean).join(' ');
        if (replace) replace.textContent = state === 'ready' ? '更换文件' : '重新定位';
    };
    let mediaError;
    for (const media of [image, video].filter(Boolean)) {
        media.addEventListener('error', () => {
            if (media.getAttribute('src')) {
                mediaError = '无法读取当前版本的媒体，请重试或打开原件。';
                report('unavailable', mediaError);
            }
        });
    }
    let version;
    let inFlight = false;
    let failed;
    let openError = '';
    let currentReference;
    const refresh = async () => {
        if (inFlight || !isCurrent()) return;
        watchedFiles.add(watch);
        watchTimer ??= setInterval(() => {
            for (const listener of watchedFiles) {
                if (!listener.isCurrent()) watchedFiles.delete(listener);
                else if (!listener.windowRef.document.hidden) void listener.refresh();
            }
            if (!watchedFiles.size) { clearInterval(watchTimer); watchTimer = undefined; }
        }, 1250);
        const workflowId = getWorkflowId();
        if (!workflowId) return;
        const fileImport = node.fileImport;
        const changedReference = fileImport !== currentReference;
        currentReference = fileImport;
        if (changedReference) {
            version = undefined;
            mediaError = '';
            failed = undefined;
            openError = '';
            open.textContent = fileImport?.name || '选择原文件';
            open.disabled = !fileImport?.id;
            preview.hidden = fileImportOutput(fileImport).name !== 'text';
            if (image) { image.hidden = true; image.removeAttribute('src'); }
            if (video) { video.hidden = true; video.removeAttribute('src'); }
            preview.value = '';
        }
        if (!fileImport?.id) {
            report('unbound', '请重新定位原文件。');
            return;
        }
        inFlight = true;
        try {
            const info = await readFileImportInfo(workflowId, node.id, fileImport);
            if (!isCurrent() || node.fileImport !== fileImport || getWorkflowId() !== workflowId) return;
            if (info.version !== version || failed) {
                mediaError = '';
                const text = info.kind === 'text' ? await readFileImportText(workflowId, node.id, fileImport, info.version) : '';
                if (!isCurrent() || node.fileImport !== fileImport || getWorkflowId() !== workflowId) return;
                preview.value = text;
                const url = fileImportUrl('content', workflowId, node.id, fileImport, info.version);
                if (image && info.kind === 'image') { image.src = url; image.hidden = false; }
                if (video && info.kind === 'video') { video.src = url; video.hidden = false; }
                if (details) details.textContent = `${info.mime} · ${new Intl.NumberFormat().format(info.size)} B`;
                version = info.version;
            }
            failed = false;
            report(mediaError ? 'unavailable' : 'ready', mediaError || openError);
        } catch (error) {
            if (isCurrent() && node.fileImport === fileImport) {
                failed = true;
                preview.value = '';
                if (image) { image.hidden = true; image.removeAttribute('src'); }
                if (video) { video.hidden = true; video.removeAttribute('src'); }
                report(error.code || 'unavailable', error.message);
            }
        } finally {
            inFlight = false;
            if (isCurrent() && node.fileImport !== fileImport) void refresh();
        }
    };
    const watch = { refresh, isCurrent, windowRef };
    if (node.fileImport?.id) report('loading', '正在读取原文件…');
    void refresh();
    node.refreshFileImport = refresh;
    replace?.addEventListener('click', () => onReplace?.(report, refresh));
    open.addEventListener('click', async () => {
        try {
            openError = '';
            if (!await windowRef.__cainflowDesktop?.openFileImport?.(getWorkflowId(), node.id, node.fileImport.id)) {
                openError = '请在 CainFlow 桌面应用打开原文件。';
                report(node.fileImportStatus, openError);
            }
        } catch (error) {
            openError = error.message || '系统无法打开原文件。';
            report(node.fileImportStatus, openError);
        }
    });
}
