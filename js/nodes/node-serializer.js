/**
 * 负责节点与连接的序列化和反序列化，为保存、导入、撤销和工作流复制提供数据结构转换。
 */
export function createNodeSerializer({ state, documentRef, getSafeProviders }) {
    function serializeNodes(includeImages = false) {
        const nodes = [];
        for (const [id, node] of state.nodes) {
            const serialized = {
                id,
                type: node.type,
                x: node.x,
                y: node.y,
                width: node.width || null,
                height: node.height || null,
                enabled: node.enabled,
                lastDuration: node.lastDuration || null
            };

            if (includeImages && node.imageData) {
                serialized.imageData = node.imageData;
            }

            if (node.type === 'ImageImport') {
                serialized.importMode = documentRef.getElementById(`${id}-import-mode`)?.value || node.importMode || 'upload';
                serialized.imageUrl = documentRef.getElementById(`${id}-url-input`)?.value || node.imageUrl || '';
            }

            if (node.type === 'ImageResize') {
                serialized.resizeMode = documentRef.getElementById(`${id}-resize-mode`)?.value || 'scale';
                serialized.scalePercent = parseInt(documentRef.getElementById(`${id}-scale-percent`)?.value || '100', 10);
                serialized.targetWidth = documentRef.getElementById(`${id}-target-width`)?.value || '';
                serialized.targetHeight = documentRef.getElementById(`${id}-target-height`)?.value || '';
                serialized.keepAspect = documentRef.getElementById(`${id}-keep-aspect`)?.checked !== false;
                serialized.quality = parseInt(documentRef.getElementById(`${id}-quality`)?.value || '92', 10);
                serialized.originalWidth = node.originalWidth || node.resizePreviewMeta?.originalWidth || 0;
                serialized.originalHeight = node.originalHeight || node.resizePreviewMeta?.originalHeight || 0;
                serialized.outputWidth = node.outputWidth || node.resizePreviewMeta?.outputWidth || 0;
                serialized.outputHeight = node.outputHeight || node.resizePreviewMeta?.outputHeight || 0;
                serialized.outputFormat = node.outputFormat || node.resizePreviewMeta?.outputFormat || '';
                serialized.outputQuality = node.outputQuality || node.resizePreviewMeta?.outputQuality || null;
                serialized.estimatedBytes = node.estimatedBytes || node.resizePreviewMeta?.estimatedBytes || null;
            }

            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                serialized.apiConfigId = documentRef.getElementById(`${id}-apiconfig`)?.value || 'default';
                serialized.prompt = documentRef.getElementById(`${id}-prompt`)?.value || '';
                if (node.type === 'ImageGenerate') {
                    serialized.aspect = documentRef.getElementById(`${id}-aspect`)?.value || '';
                    serialized.resolution = documentRef.getElementById(`${id}-resolution`)?.value || '';
                    serialized.customWidth = documentRef.getElementById(`${id}-custom-resolution-width`)?.value || '';
                    serialized.customHeight = documentRef.getElementById(`${id}-custom-resolution-height`)?.value || '';
                    serialized.customResolution = serialized.customWidth && serialized.customHeight
                        ? `${serialized.customWidth}x${serialized.customHeight}`
                        : '';
                    serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
                    serialized.generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
                } else {
                    serialized.sysprompt = documentRef.getElementById(`${id}-sysprompt`)?.value || '';
                    serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
                    serialized.fixed = documentRef.getElementById(`${id}-fixed`)?.checked || false;
                    serialized.lastResponse = node.lastResponse || '';
                    serialized.lastText = node.data?.text || '';
                    serialized.isSucceeded = node.isSucceeded || false;
                }
            }

            if (node.type === 'ImageSave') {
                serialized.filename = documentRef.getElementById(`${id}-filename`)?.value || 'generated_image';
            }
            if (node.type === 'Text') {
                serialized.text = documentRef.getElementById(`${id}-text`)?.value || '';
            }

            nodes.push(serialized);
        }
        return nodes;
    }

    function buildStatePayload(includeImages = false) {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(includeImages),
            connections: state.connections.map((connection) => ({
                id: connection.id,
                from: connection.from,
                to: connection.to,
                type: connection.type
            })),
            providers: state.providers,
            models: state.models,
            themeMode: state.themeMode,
            notificationsEnabled: state.notificationsEnabled,
            notificationVolume: state.notificationVolume,
            autoRetry: state.autoRetry,
            maxRetries: state.maxRetries,
            imageAutoResizeEnabled: state.imageAutoResizeEnabled,
            imageMaxPixels: state.imageMaxPixels,
            connectionLineType: state.connectionLineType,
            globalAnimationEnabled: state.globalAnimationEnabled,
            connectionFlowAnimationEnabled: state.globalAnimationEnabled,
            proxy: state.proxy,
            requestTimeoutEnabled: state.requestTimeoutEnabled,
            requestTimeoutSeconds: state.requestTimeoutSeconds,
            historyGridCols: state.historyGridCols
        };
    }

    function buildWorkflowExport(version = '1.2') {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map((connection) => ({
                id: connection.id,
                from: connection.from,
                to: connection.to,
                type: connection.type
            })),
            providers: getSafeProviders(),
            models: state.models,
            version
        };
    }

    return {
        serializeNodes,
        buildStatePayload,
        buildWorkflowExport
    };
}
/**
 * 负责节点与连线状态的序列化、反序列化和导出结构拼装。
 */
