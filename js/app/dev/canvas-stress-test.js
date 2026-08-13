/**
 * Dev-only canvas stress helpers. Keep this out of the main bootstrap body so
 * release/runtime logic stays focused on production startup.
 */
export function createCanvasStressTestBridge({
    state,
    addNode,
    mediaControllerApi,
    updateAllConnections,
    scheduleSave,
    showToast,
    nodesLayer,
    documentRef = document,
    globalRef = globalThis
} = {}) {
    const enabled = globalRef.CAINFLOW_ENABLE_STRESS_TEST === true
        || new URLSearchParams(globalRef.location?.search || '').get('stressTest') === '1';

    async function createCanvasStressTestNodes(options = {}) {
        const total = Number.isFinite(options.total) ? Math.max(0, Math.floor(options.total)) : 100;
        const imageImportCount = Number.isFinite(options.imageImportCount)
            ? Math.max(0, Math.min(total, Math.floor(options.imageImportCount)))
            : Math.min(50, total);
        const imageSize = Number.isFinite(options.imageSize) ? Math.max(1, Math.floor(options.imageSize)) : 2048;
        const connectionCount = Number.isFinite(options.connectionCount)
            ? Math.max(0, Math.floor(options.connectionCount))
            : Math.max(0, total * 2);
        const cols = Number.isFinite(options.cols) ? Math.max(1, Math.floor(options.cols)) : 10;
        const gapX = Number.isFinite(options.gapX) ? options.gapX : 320;
        const gapY = Number.isFinite(options.gapY) ? options.gapY : 380;
        const startX = Number.isFinite(options.startX) ? options.startX : 0;
        const startY = Number.isFinite(options.startY) ? options.startY : 0;
        const isolate = options.isolate === true;
        const ephemeral = options.ephemeral === true;

        if (isolate && !state.canvasStressTestSnapshot) {
            state.canvasStressTestSnapshot = {
                nodes: new Map(state.nodes),
                connections: state.connections.slice(),
                canvas: { ...state.canvas }
            };
            state.nodes.forEach((node) => node?.el?.remove());
            state.nodes.clear();
            state.connections = [];
        }

        function makeRandomImageDataUrl(seed) {
            const canvas = documentRef.createElement('canvas');
            canvas.width = imageSize;
            canvas.height = imageSize;

            const ctx = canvas.getContext('2d', { willReadFrequently: false });
            const imageData = ctx.createImageData(imageSize, imageSize);
            const data = imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                const pixel = i / 4;
                const x = pixel % imageSize;
                const y = Math.floor(pixel / imageSize);

                data[i] = (x * 13 + y * 7 + seed * 17) & 255;
                data[i + 1] = (x * 5 + y * 19 + seed * 31) & 255;
                data[i + 2] = (x * 11 + y * 3 + seed * 43) & 255;
                data[i + 3] = 255;
            }

            ctx.putImageData(imageData, 0, 0);
            return canvas.toDataURL('image/jpeg', 0.82);
        }

        const createdIds = [];

        for (let i = 0; i < total; i += 1) {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const x = startX + col * gapX;
            const y = startY + row * gapY;
            const isImageImport = i < imageImportCount;

            const id = addNode(isImageImport ? 'ImageImport' : 'Text', x, y, {
                customTitle: isImageImport ? `压力测试图片 ${i + 1}` : `压力测试文本 ${i + 1}`,
                text: `测试节点 ${i + 1}`
            }, true);

            if (!id) continue;
            createdIds.push(id);

            if (isImageImport) {
                const dataUrl = makeRandomImageDataUrl(i);
                const node = state.nodes.get(id);

                if (node) {
                    node.importMode = 'upload';
                    node.imageUrl = '';
                    node.imageData = dataUrl;
                    node.imageDataList = [dataUrl];
                    node.data = node.data || {};
                    node.data.image = dataUrl;
                    node.data.imageCount = 1;
                    node.originalWidth = imageSize;
                    node.originalHeight = imageSize;

                    mediaControllerApi.renderImageImportUploadState(id, dataUrl);
                }
            }

            if (i % 5 === 0) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
        }

        const textNodeIds = createdIds.slice(imageImportCount);
        for (let index = 0; index < connectionCount && textNodeIds.length > 1; index += 1) {
            const fromId = textNodeIds[index % textNodeIds.length];
            const toId = textNodeIds[(index * 7 + 11) % textNodeIds.length];
            if (fromId === toId) continue;
            state.connections.push({
                id: `stress_${Date.now().toString(36)}_${index}`,
                from: { nodeId: fromId, port: 'text' },
                to: { nodeId: toId, port: 'text' },
                type: 'text'
            });
        }

        updateAllConnections();
        if (!ephemeral) scheduleSave();

        const message = `已生成 ${createdIds.length} 个压力测试节点，其中 ${imageImportCount} 个图片导入节点加载了 ${imageSize}x${imageSize} 随机图片。`;
        console.log(message);
        showToast(message, 'success');

        return createdIds;
    }

    function clearCanvasStressTestNodes() {
        const stressNodeIds = new Set(Array.from(state.nodes.entries())
            .filter(([, node]) => node?.el?.innerText?.startsWith('压力测试'))
            .map(([nodeId]) => nodeId));
        const snapshot = state.canvasStressTestSnapshot;
        if (!stressNodeIds.size && !snapshot) return 0;
        state.connections = state.connections.filter((connection) => (
            !stressNodeIds.has(connection.from?.nodeId) &&
            !stressNodeIds.has(connection.to?.nodeId)
        ));
        stressNodeIds.forEach((nodeId) => {
            state.nodes.get(nodeId)?.el?.remove();
            state.nodes.delete(nodeId);
        });
        if (snapshot) {
            state.nodes = snapshot.nodes;
            state.connections = snapshot.connections;
            Object.assign(state.canvas, snapshot.canvas);
            state.nodes.forEach((node) => nodesLayer?.appendChild(node.el));
            state.canvasStressTestSnapshot = null;
        }
        updateAllConnections();
        if (!snapshot) scheduleSave();
        showToast(`已清理 ${stressNodeIds.size} 个压力测试节点。`, 'info');
        return stressNodeIds.size;
    }

    return {
        enabled,
        createCanvasStressTestNodes,
        clearCanvasStressTestNodes
    };
}
