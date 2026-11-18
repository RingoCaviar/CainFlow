import { COMMERCE_SHOT_REFERENCE_LIMIT, updateCommerceShotReferences } from './commerce-shot-references.js';

export function createCommerceShotReferenceControls({ documentRef, node, getSettings, uploadReference,
    readAsset, openPreview, onChange }) {
    const element = documentRef.createElement('details');
    element.className = 'commerce-shot-references';
    element.innerHTML = '<summary>图位参考图<span>选填</span></summary><p>借鉴构图与视觉风格，商品外观仍以商品参考图为准。</p><div class="commerce-shot-reference-list"></div>';
    const list = element.querySelector('.commerce-shot-reference-list');
    const rows = new Map();
    let destroyed = false;
    let lastShots = [];
    let lastOptions = {};

    function createRow(shot) {
        const row = documentRef.createElement('div');
        row.className = 'commerce-shot-reference-row';
        row.dataset.commerceReferenceShot = shot.id;
        row.innerHTML = '<div class="commerce-shot-reference-heading"><strong></strong><button type="button" class="btn" data-commerce-reference-add>添加参考</button></div><div class="commerce-shot-reference-images"></div><input type="file" accept="image/*" hidden><p class="commerce-shot-reference-status" role="status" hidden></p>';
        row.querySelector('strong').textContent = shot.label;
        const input = row.querySelector('input');
        input.setAttribute('aria-label', `上传「${shot.label}」的设计参考图`);
        const add = row.querySelector('[data-commerce-reference-add]');
        const images = row.querySelector('.commerce-shot-reference-images');
        const status = row.querySelector('[role=status]');
        const item = { row, input, add, images, status, pending: false, locked: false, key: '', replaceIndex: -1 };
        function setStatus(message) {
            status.textContent = message;
            status.hidden = !message;
        }
        function pick(index = -1) {
            if (item.locked || item.pending) return;
            item.replaceIndex = index;
            input.value = '';
            input.click();
        }
        add.addEventListener('click', () => pick());
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file || item.locked || item.pending || !uploadReference) return;
            const before = [...(getSettings().shotReferences?.[shot.id] || [])];
            item.pending = true;
            setStatus('正在保存参考图…');
            update(lastShots, lastOptions);
            try {
                const key = await uploadReference(node, file);
                if (destroyed) return;
                const settings = getSettings();
                const selectedIds = settings.selectedShotIds || settings.plan?.shots.map(shot => shot.id) || [];
                if (!selectedIds.includes(shot.id) || JSON.stringify(settings.shotReferences?.[shot.id] || []) !== JSON.stringify(before)) {
                    throw new Error('图位参考已变化，请重新选择图片。');
                }
                const next = [...before];
                if (item.replaceIndex >= 0) next[item.replaceIndex] = key;
                else next.push(key);
                if (!updateCommerceShotReferences(settings, shot.id, next)) throw new Error('参考图没有变化。');
                onChange({ commerceShotId: shot.id, commerceReferencesChanged: true });
                setStatus('');
            } catch (error) {
                if (!destroyed) setStatus(error?.message || '参考图保存失败，请重试。');
            } finally {
                item.pending = false;
                if (!destroyed) update(lastShots, lastOptions);
            }
        });
        item.render = keys => {
            const key = JSON.stringify(keys);
            if (item.key === key) return;
            item.key = key;
            images.replaceChildren();
            keys.forEach((assetKey, index) => {
                const holder = documentRef.createElement('div');
                holder.className = 'commerce-shot-reference-image';
                holder.innerHTML = '<button type="button" data-commerce-reference-preview><img></button><div><button type="button" class="btn" data-commerce-reference-replace>替换</button><button type="button" class="btn" data-commerce-reference-remove>移除</button></div>';
                const preview = holder.querySelector('[data-commerce-reference-preview]');
                preview.setAttribute('aria-label', `预览「${shot.label}」的第 ${index + 1} 张设计参考`);
                const image = holder.querySelector('img');
                image.alt = `${shot.label}设计参考 ${index + 1}`;
                image.src = `/api/storage/assets/${encodeURIComponent(assetKey)}`;
                image.addEventListener('error', () => setStatus('设计参考图不可用，请替换或移除。'));
                preview.addEventListener('click', async () => {
                    try {
                        const value = await readAsset?.(assetKey);
                        if (!value) throw new Error('设计参考图不可用，请替换或移除。');
                        if (!destroyed) openPreview?.([value], 0, () => preview.isConnected && preview.focus({ preventScroll: true }));
                    } catch (error) { if (!destroyed) setStatus(error?.message || '无法预览设计参考图。'); }
                });
                holder.querySelector('[data-commerce-reference-replace]').addEventListener('click', () => pick(index));
                holder.querySelector('[data-commerce-reference-remove]').addEventListener('click', () => {
                    if (item.locked || item.pending) return;
                    const current = getSettings();
                    if (updateCommerceShotReferences(current, shot.id, keys.filter((_, position) => position !== index))) {
                        setStatus('');
                        onChange({ commerceShotId: shot.id, commerceReferencesChanged: true });
                        update(lastShots, lastOptions);
                    }
                });
                images.append(holder);
            });
        };
        return item;
    }

    function update(shots, { locked = false, activeShotIds = [], finalizedShotIds = [] } = {}) {
        lastShots = shots;
        lastOptions = { locked, activeShotIds, finalizedShotIds };
        const ids = new Set(shots.map(shot => shot.id));
        for (const [id, item] of rows) if (!ids.has(id)) { item.row.remove(); rows.delete(id); }
        element.hidden = shots.length === 0;
        for (const shot of shots) {
            if (!rows.has(shot.id)) rows.set(shot.id, createRow(shot));
            const item = rows.get(shot.id);
            const keys = getSettings().shotReferences?.[shot.id] || [];
            item.locked = locked || activeShotIds.includes(shot.id) || finalizedShotIds.includes(shot.id);
            item.render(keys);
            item.add.disabled = item.locked || item.pending || keys.length >= COMMERCE_SHOT_REFERENCE_LIMIT || !uploadReference;
            item.row.querySelectorAll('[data-commerce-reference-replace], [data-commerce-reference-remove]').forEach(button => {
                button.disabled = item.locked || item.pending;
            });
            if (item.row.parentNode !== list) list.append(item.row);
        }
    }

    return { element, update, destroy: () => { destroyed = true; rows.clear(); element.remove(); } };
}
