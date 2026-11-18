import {
    COMMERCE_SHOT_REFERENCE_LIMIT, setCommerceConnectedReferenceType, updateCommerceShotReferences
} from './commerce-shot-references.js';
import { describeCanvasImageSlot } from '../media/reference-image-catalog.js';

const shared = '*';
const keysFor = (settings, type) => settings.shotReferences?.[type] || [];

export function describeCommerceReferenceMedia(entry) {
    if (entry.missing) return null;
    if (entry.image) return { imageUrl: entry.image, previewUrl: entry.image };
    const candidate = entry.bindingId ? describeCanvasImageSlot(entry.source, entry.connection.from.port, entry.index)
        : { assetKey: entry.assetKey };
    if (candidate && !candidate.previewUrl && candidate.legacyAssetIndex === undefined && candidate.assetKey?.startsWith('media:')) {
        candidate.previewUrl = `/api/storage/assets/${encodeURIComponent(candidate.assetKey)}`;
    }
    return candidate;
}

export function createCommerceShotReferenceControls({ documentRef, node, getSettings, pickReference,
    catalog, openPreview, onChange }) {
    const element = documentRef.createElement('details');
    element.className = 'commerce-shot-references';
    element.innerHTML = `<summary>风格参考图<span>选填</span></summary>
        <p>从场景、历史选图，或连接「风格参考图」输入。未指定类型时，整套图位共用这张参考。</p>
        <div class="commerce-shot-reference-heading">
            <select class="ui-select" aria-label="新参考图的图位类型" data-commerce-reference-add-type></select>
            <button type="button" class="btn" data-commerce-reference-add aria-haspopup="dialog">添加参考图</button>
        </div>
        <div class="commerce-shot-reference-list"></div>
        <p data-commerce-reference-connections hidden></p>
        <p class="commerce-shot-reference-status" role="status" hidden></p>`;
    const list = element.querySelector('.commerce-shot-reference-list');
    const add = element.querySelector('[data-commerce-reference-add]');
    const addType = element.querySelector('[data-commerce-reference-add-type]');
    const connectionStatus = element.querySelector('[data-commerce-reference-connections]');
    const status = element.querySelector('[role=status]');
    const lifetime = new AbortController();
    const rows = new Map();
    const optionKeys = new WeakMap();
    let shots = [];
    let shotIds = [];
    let connected = { groups: [], slots: [] };
    let locked = false;
    let blockedTypes = new Set();
    let picking = false;

    // The node form refreshes and autosaves on input. Commit the image's type on change first.
    for (const name of ['input', 'change']) element.addEventListener(name, event => {
        if (event.target.tagName === 'SELECT') event.stopPropagation();
    });

    function setStatus(message) {
        status.hidden = !message;
        status.textContent = message;
    }

    function typeLocked(type) {
        return locked || (type === shared ? blockedTypes.size > 0 : blockedTypes.has(type));
    }

    function setOptions(select, current, { picked = true, adding = false } = {}) {
        const options = [[shared, '不指定类型（整套）'], ...shots.map(shot => [shot.id, shot.label])];
        const signature = JSON.stringify(options);
        if (optionKeys.get(select) !== signature) {
            select.replaceChildren(...options.map(([id, label]) => {
                const option = documentRef.createElement('option');
                option.value = id === shared ? '' : id;
                option.textContent = label;
                return option;
            }));
            optionKeys.set(select, signature);
        }
        for (const option of select.options) {
            const type = option.value || shared;
            option.disabled = (adding || type !== current) && (typeLocked(type)
                || (picked && keysFor(getSettings(), type).length >= COMMERCE_SHOT_REFERENCE_LIMIT));
        }
        select.value = current === shared ? '' : current;
        if (adding && (!select.selectedOptions.length || select.selectedOptions[0].disabled)) {
            const available = [...select.options].find(option => !option.disabled);
            if (available) select.value = available.value;
        }
    }

    async function pick(type, previousKey) {
        const before = [...keysFor(getSettings(), type)];
        if (picking || typeLocked(type) || !pickReference) return;
        picking = true;
        setStatus('');
        render();
        try {
            const key = await pickReference(node, { signal: lifetime.signal });
            if (!key || lifetime.signal.aborted) return;
            const settings = getSettings();
            if (typeLocked(type) || (type !== shared && !shotIds.includes(type))
                || JSON.stringify(keysFor(settings, type)) !== JSON.stringify(before)) {
                throw new Error('参考图设置已变化，请重新选择。');
            }
            if (key === previousKey) return;
            if (before.includes(key)) throw new Error('这个图位已添加同一张参考图。');
            const next = previousKey ? before.map(item => item === previousKey ? key : item) : [...before, key];
            if (updateCommerceShotReferences(settings, type, next, shotIds)) onChange({ commerceReferencesChanged: true });
        } catch (error) {
            if (!lifetime.signal.aborted) setStatus(error.message || '无法添加参考图。');
        } finally {
            picking = false;
            if (!lifetime.signal.aborted) render();
        }
    }

    function changeType(entry, type) {
        if (entry.type === type || picking || typeLocked(entry.type) || typeLocked(type)) return;
        const settings = getSettings();
        if (entry.bindingId) {
            if (!setCommerceConnectedReferenceType(settings, entry.bindingId, type === shared ? '' : type, shotIds)) return;
        } else {
            const destination = keysFor(settings, type);
            if (destination.includes(entry.assetKey)) {
                setStatus('这个图位已添加同一张参考图。');
                return;
            }
            if (destination.length >= COMMERCE_SHOT_REFERENCE_LIMIT
                || !updateCommerceShotReferences(settings, type, [...destination, entry.assetKey], shotIds)) return;
            updateCommerceShotReferences(settings, entry.type, keysFor(settings, entry.type).filter(key => key !== entry.assetKey), shotIds);
        }
        setStatus('');
        onChange({ commerceReferencesChanged: true });
    }

    function createRow() {
        const row = documentRef.createElement('div');
        row.className = 'commerce-shot-reference-row';
        row.innerHTML = `<button type="button" class="commerce-shot-reference-thumb" data-commerce-reference-preview><img alt=""></button>
            <div class="commerce-shot-reference-fields"><span></span><select class="ui-select" data-commerce-reference-type></select>
                <div class="commerce-shot-reference-actions"><button type="button" class="btn" data-commerce-reference-replace aria-haspopup="dialog">替换</button>
                <button type="button" class="btn" data-commerce-reference-remove>移除</button></div></div>`;
        const preview = row.querySelector('[data-commerce-reference-preview]');
        const image = preview.querySelector('img');
        const label = row.querySelector('span');
        const select = row.querySelector('select');
        const replace = row.querySelector('[data-commerce-reference-replace]');
        const remove = row.querySelector('[data-commerce-reference-remove]');
        const item = { row, preview, image, label, select, replace, remove, entry: null };
        image.addEventListener('error', () => {
            if (!lifetime.signal.aborted && row.isConnected) setStatus(`${item.entry.label}无法显示，请检查原图。`);
        });
        preview.addEventListener('click', async () => {
            try {
                const candidate = item.media;
                const url = candidate?.imageUrl || await catalog?.readImage(candidate);
                if (!url) throw new Error('风格参考图不可用，请检查来源。');
                if (!lifetime.signal.aborted && preview.isConnected && item.media?.sourceId === candidate.sourceId) {
                    await openPreview?.([url], 0, () => preview.focus({ preventScroll: true }));
                }
            } catch (error) { if (!lifetime.signal.aborted) setStatus(error.message || '无法预览参考图。'); }
        });
        select.addEventListener('change', () => {
            changeType(item.entry, select.value || shared);
            render();
        });
        replace.addEventListener('click', () => pick(item.entry.type, item.entry.assetKey));
        remove.addEventListener('click', () => {
            const { type, assetKey } = item.entry;
            if (picking || typeLocked(type)) return;
            const settings = getSettings();
            if (updateCommerceShotReferences(settings, type, keysFor(settings, type).filter(key => key !== assetKey), shotIds)) {
                setStatus('');
                onChange({ commerceReferencesChanged: true });
            }
        });
        return item;
    }

    function render() {
        const settings = getSettings();
        const entries = [shared, ...shotIds].flatMap(type => keysFor(settings, type).map(assetKey => ({ type, assetKey })));
        entries.forEach((entry, index) => { entry.label = `已选参考图 ${index + 1}`; });
        for (const slot of connected.slots) {
            entries.push({ ...slot, type: settings.styleReferenceTypes?.[slot.bindingId] || shared,
                label: `连线 · ${slot.source.customTitle || slot.source.el?.dataset.nodeTitle || '图片来源'} · 第 ${slot.index + 1} 张` });
        }
        const live = new Set();
        for (const entry of entries) {
            const id = entry.bindingId || JSON.stringify([entry.type, entry.assetKey]);
            live.add(id);
            const item = rows.get(id) || createRow();
            rows.set(id, item);
            item.entry = entry;
            item.row.dataset.commerceReferenceSource = entry.bindingId ? 'connection' : 'selection';
            item.row.dataset.commerceReferenceKey = entry.bindingId || entry.assetKey;
            const media = describeCommerceReferenceMedia(entry);
            const previous = item.media;
            item.media = media;
            if (media?.previewUrl) {
                if (item.image.getAttribute('src') !== media.previewUrl) item.image.src = media.previewUrl;
            } else if (!media || previous?.sourceId !== media.sourceId || previous?.previewUrl) {
                item.image.removeAttribute('src');
                if (media && catalog) void catalog.readThumbnail(media).catch(() => '').then(url => {
                    if (lifetime.signal.aborted || rows.get(id) !== item || item.media?.sourceId !== media.sourceId) return;
                    if (url) item.image.src = url;
                    else setStatus(`${entry.label}无法显示，请检查原图。`);
                });
            }
            item.label.textContent = entry.label;
            item.preview.disabled = !media;
            item.preview.setAttribute('aria-label', `预览${entry.label}`);
            item.select.setAttribute('aria-label', `${entry.label}的图位类型`);
            setOptions(item.select, entry.type, { picked: !entry.bindingId });
            item.select.disabled = picking || typeLocked(entry.type);
            item.replace.parentElement.hidden = !!entry.bindingId;
            item.replace.disabled = item.select.disabled || !pickReference;
            item.remove.disabled = item.select.disabled;
            const at = list.children[live.size - 1];
            if (at !== item.row) list.insertBefore(item.row, at || null);
        }
        for (const [id, item] of rows) if (!live.has(id)) { item.row.remove(); rows.delete(id); }
        const pendingGroups = connected.groups.filter(group => !group.enabled || group.running || !group.count || group.missing || group.missingPositions.length);
        connectionStatus.hidden = !pendingGroups.length;
        connectionStatus.textContent = pendingGroups.map(group => `${group.name}：${group.running ? '运行中' : !group.enabled ? '来源已停用' : '等待可用的图片'}`).join('；');
        setOptions(addType, addType.value || shared, { adding: true });
        addType.disabled = picking || locked;
        add.disabled = picking || locked || !pickReference || ![...addType.options].some(option => !option.disabled);
    }
    add.addEventListener('click', () => pick(addType.value || shared));
    return {
        element,
        update(types, { styleReferences, locked: disabled = false, activeShotIds = [], finalizedShotIds = [] }) {
            shots = types;
            shotIds = types.map(shot => shot.id);
            connected = styleReferences;
            locked = disabled;
            blockedTypes = new Set([...activeShotIds, ...finalizedShotIds]);
            render();
        },
        destroy() { lifetime.abort(); rows.clear(); element.remove(); }
    };
}
