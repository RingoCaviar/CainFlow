const notifiedMissingSets = new Map();

function redactedAssetIdentity(assetKey) {
    const value = String(assetKey || '');
    return value.length <= 18 ? value : `${value.slice(0, 12)}…${value.slice(-6)}`;
}

export async function projectMissingMediaAssets({
    workflowId,
    node,
    assetKeys,
    mediaType = 'image',
    ownerType = 'workflow-node',
    loadAsset,
    notify = () => {},
    onIntegrityChange = () => {}
}) {
    const keys = Array.isArray(assetKeys) ? assetKeys.slice() : [];
    const values = await Promise.all(keys.map((assetKey) => loadAsset(assetKey)));
    const items = keys.map((assetKey, position) => ({
        position,
        assetKey,
        redactedSource: redactedAssetIdentity(assetKey),
        value: values[position] || null,
        missing: !values[position],
        workflowId: String(workflowId || ''),
        nodeId: String(node?.id || ''),
        ownerType,
        ownerId: `${String(workflowId || '')}:${String(node?.id || '')}`,
        mediaType
    }));
    const missingItems = items.filter((item) => item.missing);
    node.data = node.data || {};
    const previousSignature = (node.data.mediaIntegrity?.missingItems || [])
        .map((item) => `${item.position}:${item.assetKey}`)
        .join('|');
    if (missingItems.length > 0) {
        node.data.mediaIntegrity = {
            state: 'missing', mediaType, ownerType, itemCount: items.length,
            missingItems: missingItems.map(({ value, missing, ...item }) => item)
        };
    } else {
        delete node.data.mediaIntegrity;
    }
    const signature = missingItems.map((item) => `${item.position}:${item.assetKey}`).join('|');
    if (previousSignature !== signature) onIntegrityChange(node.data.mediaIntegrity || null);
    const notificationKey = `${workflowId}:${node?.id || ''}`;
    if (signature && notifiedMissingSets.get(notificationKey) !== signature) {
        notifiedMissingSets.set(notificationKey, signature);
        notify(`节点 ${node?.id || ''} 有 ${missingItems.length} 个本地媒体缺失，引用位置已保留。`, 'warning');
    } else if (!signature) {
        notifiedMissingSets.delete(notificationKey);
    }
    return items;
}

export function renderMissingMediaPlaceholders(node, container, documentRef = document, onAction = () => {}) {
    if (!container) return;
    container.querySelectorAll?.('.missing-media-asset-placeholder').forEach((element) => element.remove());
    const missingItems = node?.data?.mediaIntegrity?.missingItems || [];
    const activePosition = Number.isInteger(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
    if (missingItems.some((item) => item.position === activePosition)) {
        container.querySelector?.('.preview-placeholder')?.remove();
    }
    for (const item of missingItems) {
        const placeholder = documentRef.createElement('div');
        placeholder.className = 'missing-media-asset-placeholder';
        placeholder.dataset.position = String(item.position);
        placeholder.dataset.mediaType = item.mediaType;
        placeholder.style?.setProperty?.('--missing-media-position', String(item.position));
        placeholder.hidden = item.position !== activePosition;
        const message = documentRef.createElement('span');
        message.textContent = `第 ${item.position + 1} 项本地媒体缺失 · ${item.redactedSource}`;
        placeholder.appendChild(message);
        const select = documentRef.createElement('input');
        select.type = 'checkbox';
        select.className = 'missing-media-asset-select';
        select.dataset.position = String(item.position);
        select.setAttribute?.('aria-label', `选择第 ${item.position + 1} 项缺失媒体`);
        placeholder.appendChild(select);
        for (const [action, label] of [['remote-recover', '远程恢复'], ['local-recover', '本地恢复'], ['replace', '替换'], ['remove', '移除引用']]) {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'missing-media-asset-action';
            button.dataset.action = action;
            button.dataset.position = String(item.position);
            button.textContent = label;
            button.addEventListener?.('click', () => onAction({ action, item, node }));
            placeholder.appendChild(button);
        }
        const batchRemove = documentRef.createElement('button');
        batchRemove.type = 'button';
        batchRemove.className = 'missing-media-asset-action';
        batchRemove.textContent = '移除已选';
        batchRemove.addEventListener?.('click', () => onAction({
            action: 'remove-selected', node,
            positions: Array.from(container.querySelectorAll?.('.missing-media-asset-select:checked') || [])
                .map((element) => Number(element.dataset.position))
        }));
        placeholder.appendChild(batchRemove);
        container.appendChild(placeholder);
    }
}

export function resetMissingMediaNotifications() {
    notifiedMissingSets.clear();
}
