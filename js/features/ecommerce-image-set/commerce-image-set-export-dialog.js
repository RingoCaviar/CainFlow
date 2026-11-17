import { getImageExtension } from '../media/preview-image-download.js';
import { saveZipArchive } from '../media/zip-download.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

const scopes = { all: '全套', gallery: '主副图', detail: '详情图' };
const assetUrl = key => `/api/storage/assets/${encodeURIComponent(key)}`;
const imageExtension = mime => getImageExtension(`data:${(mime || '').split(';')[0].trim().toLowerCase()};`);

export function openCommerceImageSetExport({ manifest, previousManifest, documentRef, opener, onClose }) {
    const windowRef = documentRef.defaultView;
    const dialog = documentRef.createElement('dialog');
    dialog.id = 'commerce-export-dialog';
    dialog.className = 'dialog-style-1 commerce-export-dialog';
    dialog.setAttribute('aria-labelledby', 'commerce-export-title');
    dialog.innerHTML = `
        <div class="dialog-style-1-panel">
            <header class="dialog-style-1-header">
                <h2 id="commerce-export-title">导出套图</h2>
                <button type="button" class="dialog-style-1-close" aria-label="关闭导出套图">×</button>
            </header>
            <div class="dialog-style-1-body">
                ${previousManifest ? `<fieldset class="commerce-export-scopes">
                    <legend>套图版本</legend>
                    <div>
                        <label><input type="radio" name="commerce-export-version" value="current" checked><span>当前套图</span></label>
                        <label><input type="radio" name="commerce-export-version" value="previous"><span>上次套图</span></label>
                    </div>
                </fieldset>` : ''}
                <fieldset class="commerce-export-scopes">
                    <legend>导出范围</legend>
                    <div>${Object.entries(scopes).map(([id, label]) => `
                        <label><input type="radio" name="commerce-export-scope" value="${id}" data-commerce-export-scope="${id}"${id === 'all' ? ' checked autofocus' : ''}>
                            <span>${label}</span></label>`).join('')}</div>
                </fieldset>
                <p class="commerce-export-summary" role="status" tabindex="-1"></p>
                <ol class="commerce-export-rows"></ol>
                <p class="commerce-export-unmapped" hidden></p>
                <p class="commerce-export-error" role="alert" hidden></p>
            </div>
            <footer class="dialog-style-1-footer">
                <button type="button" class="btn btn-secondary" data-commerce-export-close>关闭</button>
                <button type="button" class="btn btn-primary" data-commerce-export-download disabled>导出 ZIP</button>
            </footer>
        </div>`;
    const filterInputs = dialog.querySelectorAll('[name="commerce-export-scope"], [name="commerce-export-version"]');
    const summary = dialog.querySelector('.commerce-export-summary');
    const list = dialog.querySelector('.commerce-export-rows');
    const unmapped = dialog.querySelector('.commerce-export-unmapped');
    const feedback = dialog.querySelector('.commerce-export-error');
    const closeButtons = dialog.querySelectorAll('.dialog-style-1-close, [data-commerce-export-close]');
    const download = dialog.querySelector('[data-commerce-export-download]');
    const availability = new Map();
    const controller = new AbortController();
    const { signal } = controller;
    const surfaces = getSurfaceCoordinator(documentRef);
    let scope = 'all';
    let selectedManifest = manifest;
    let checking = true;
    let saving = false;

    function selectedRows() {
        return scope === 'all' ? selectedManifest.rows : selectedManifest.rows.filter(row => row.group === scope);
    }

    function render(message = '') {
        const rows = selectedRows();
        const ready = rows.filter(row => availability.get(row.assetKey)?.extension);
        const previous = ready.filter(row => row.status === 'previous').length;
        const missing = rows.length - ready.length;
        closeButtons.forEach(button => { button.disabled = saving; });
        filterInputs.forEach(input => { input.disabled = saving; });
        unmapped.hidden = !selectedManifest.unmappedCount || selectedManifest === previousManifest;
        if (!unmapped.hidden) unmapped.textContent = `有 ${selectedManifest.unmappedCount} 张已保存图片缺少图位记录，已跳过。`;
        download.disabled = checking || saving || !ready.length;
        summary.textContent = message || (checking ? '正在检查本地成图…' : !rows.length ? '此范围没有图位。'
            : [`可导出 ${ready.length} 张`, missing && `缺图 ${missing} 张`, previous && `含上一版 ${previous} 张`].filter(Boolean).join(' · '));
        list.hidden = !rows.length;
        list.replaceChildren(...rows.map(row => {
            const item = documentRef.createElement('li');
            item.dataset.commerceExportShot = row.shotId;
            const asset = availability.get(row.assetKey);
            const rowStatus = asset?.extension ? row.status : checking && row.assetKey ? 'checking' : 'missing';
            item.dataset.exportStatus = rowStatus;
            const number = documentRef.createElement('span');
            number.className = 'commerce-export-number';
            number.textContent = String(row.number).padStart(2, '0');
            const name = documentRef.createElement('span');
            name.textContent = row.label;
            const status = documentRef.createElement('span');
            status.className = 'commerce-export-row-status';
            status.textContent = { current: '可导出', previous: '上一版', checking: '检查中' }[rowStatus] || asset?.message || '缺图';
            item.append(number, name, status);
            return item;
        }));
    }

    function showError(message) {
        feedback.hidden = !message;
        feedback.textContent = message;
    }

    function close() {
        if (signal.aborted) return;
        controller.abort();
        dialog.close();
        dialog.remove();
        surfaces?.refresh();
        if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
        onClose?.();
    }

    function requestClose(event) {
        event?.preventDefault();
        if (!saving) close();
    }

    async function checkAssets() {
        const keys = new Set([...manifest.rows, ...(previousManifest?.rows || [])].map(row => row.assetKey).filter(Boolean));
        await Promise.all([...keys].map(async key => {
            try {
                const response = await windowRef.fetch(assetUrl(key), { method: 'HEAD', cache: 'no-store', signal });
                if (response.status === 404 || response.status === 410 || response.headers.get('content-length') === '0') return;
                if (!response.ok) throw new Error('无法读取原图');
                const extension = imageExtension(response.headers.get('content-type'));
                availability.set(key, extension ? { extension } : { message: '格式不支持' });
            } catch {
                if (!signal.aborted) availability.set(key, { message: '无法读取' });
            }
        }));
        if (signal.aborted) return;
        checking = false;
        render();
    }

    async function readArchiveEntries(rows) {
        const entries = [];
        for (const row of rows) {
            try {
                const response = await windowRef.fetch(assetUrl(row.assetKey), { cache: 'no-store', signal });
                if (!response.ok) throw new Error('读取失败');
                const image = await response.blob();
                const extension = imageExtension(image.type);
                if (!extension || !image.size) throw new Error('图像文件无效');
                entries.push({ path: row.fileStem + extension, bytes: new Uint8Array(await image.arrayBuffer()) });
            } catch {
                signal.throwIfAborted();
                availability.set(row.assetKey, { message: '无法读取' });
                throw new Error(`无法读取「${row.label}」的原图。请检查剩余图位后重新导出。`);
            }
        }
        signal.throwIfAborted();
        return entries;
    }

    dialog.addEventListener('change', event => {
        if (saving) return;
        if (event.target.name === 'commerce-export-scope') scope = event.target.value;
        else if (event.target.name === 'commerce-export-version') {
            selectedManifest = event.target.value === 'previous' ? previousManifest : manifest;
        } else return;
        showError('');
        render();
    });
    closeButtons.forEach(button => button.addEventListener('click', requestClose));
    dialog.addEventListener('cancel', requestClose);
    dialog.addEventListener('close', close);
    download.addEventListener('click', async () => {
        if (checking || saving) return;
        const rows = selectedRows().filter(row => availability.get(row.assetKey)?.extension);
        if (!rows.length) return;
        saving = true;
        showError('');
        render('正在准备 ZIP…');
        summary.focus({ preventScroll: true });
        let message = '';
        try {
            const result = await saveZipArchive(`${selectedManifest.title}_${scopes[scope]}.zip`, () => readArchiveEntries(rows), { windowRef, documentRef });
            if (result === 'saved') message = `已保存 ZIP，包含 ${rows.length} 张图。`;
            if (result === 'started') message = `已开始下载 ZIP，包含 ${rows.length} 张图。`;
        } catch (error) {
            if (!signal.aborted) showError(error?.message || '无法导出 ZIP，请重试。');
        } finally {
            saving = false;
            if (!signal.aborted) {
                render(message);
                (download.disabled ? closeButtons[1] : download).focus({ preventScroll: true });
            }
        }
    });

    render();
    documentRef.body.append(dialog);
    try {
        dialog.showModal();
        surfaces?.registerEscape(dialog, requestClose);
    } catch (error) {
        close();
        throw error;
    }
    void checkAssets();
    return close;
}
