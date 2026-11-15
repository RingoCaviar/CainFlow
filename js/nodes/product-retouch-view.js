import { getProductRetouchModelOptions, normalizeProductRetouchSettings } from '../features/product-retouch/product-retouch-settings.js';
import { readProductRetouchComparison } from '../features/product-retouch/product-retouch-comparison.js';
import { getCanonicalImageList } from '../features/execution/execution-data-utils.js';
import { projectImageReferences } from './image-reference-projection.js';
import { createProductRetouchComparison, renderProductRetouchComparison } from './product-retouch-comparison-view.js';

const photoIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 16 5-5 5 5 3-3 5 5"/><circle cx="16" cy="9" r="1"/></svg>';
const uploadIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const retouchIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z"/></svg>';
const backgrounds = [['white', '白底'], ['black', '黑底'], ['original', '原背景']];
let viewId = 0;

export function renderProductRetouchBody() {
    return `<div class="product-retouch-card">
        ${renderProductRetouchComparison()}
        <div class="product-retouch-card-empty"><span>${retouchIcon}</span><strong>产品精修</strong><small>连接或上传商品参考图</small></div>
    </div>`;
}

function imageUrl(image, assetKey) {
    return image || (assetKey?.startsWith('media:') ? `/api/storage/assets/${encodeURIComponent(assetKey)}` : '');
}

function updatePreview(button, url) {
    const image = button.querySelector('img');
    if (url && image.getAttribute('src') !== url) image.src = url;
    else if (!url) image.removeAttribute('src');
    button.hidden = !url;
}

export function createProductRetouchView({
    node, state, documentRef, inputDetails, run, waitForNodeRun, uploadReference, openReferencePreview,
    openResultPreview, openModelSettings, openNodeFailureLog
}) {
    const panelId = `retouch-${++viewId}`;
    const card = node.el.querySelector('.product-retouch-card');
    const emptyCard = card.querySelector('.product-retouch-card-empty');
    const element = documentRef.createElement('div');
    element.className = 'product-retouch-settings';
    element.innerHTML = `
        <section class="product-retouch-source" aria-labelledby="${panelId}-source">
            <h3 id="${panelId}-source">商品参考图</h3>
            <div class="product-retouch-source-frame">
                <button type="button" class="product-retouch-source-preview" data-retouch-action="preview-source" aria-label="查看商品参考图" data-node-read-action hidden><img alt="商品参考图"></button>
                <span class="product-retouch-source-icon">${photoIcon}</span>
                <div class="product-retouch-source-copy"><strong></strong><span></span></div>
                <button type="button" class="product-retouch-upload" data-retouch-action="upload">${uploadIcon}<span>上传</span></button>
                <input type="file" accept="image/*" data-retouch-upload aria-label="上传商品参考图" hidden>
            </div>
            <details class="product-retouch-connections" hidden><summary>连接明细</summary></details>
        </section>
        <fieldset class="product-retouch-background">
            <legend>背景</legend>
            <div class="product-retouch-swatches">${backgrounds.map(([value, label]) => `
                <label><input type="radio" name="${panelId}-background" value="${value}" data-retouch-field="background">
                    <span class="product-retouch-swatch" data-background="${value}" aria-hidden="true">${value === 'original' ? photoIcon : ''}</span><span>${label}</span></label>`).join('')}</div>
        </fieldset>
        <div class="product-retouch-treatment">
            <label>布光<select data-retouch-field="lighting"><option value="soft">柔光</option><option value="balanced">均匀光</option><option value="dramatic">轮廓光</option></select></label>
            <label>阴影<select data-retouch-field="shadow"><option value="natural">自然阴影</option><option value="none">无阴影</option></select></label>
            <label>精修风格<select data-retouch-field="finish"><option value="natural">自然质感</option><option value="polished">棚拍质感</option></select></label>
        </div>
        <details class="product-retouch-disclosure">
            <summary>补充要求</summary>
            <textarea data-retouch-field="notes" aria-label="补充要求" rows="3" maxlength="1000" placeholder="例如保留瓶身磨砂质感，清理表面的指纹"></textarea>
        </details>
        <details class="product-retouch-disclosure product-retouch-model">
            <summary>模型与供应商 <span></span></summary>
            <div class="product-retouch-model-fields">
                <label>精修模型<select data-retouch-field="modelId"></select></label>
                <label>供应商<select data-retouch-field="providerId"></select></label>
            </div>
            <button type="button" class="product-retouch-link" data-retouch-action="configure">打开模型设置</button>
        </details>`;
    const actions = documentRef.createElement('div');
    actions.className = 'product-retouch-footer';
    actions.innerHTML = `<p role="status"></p>
        <p data-retouch-comparison-status hidden>该结果没有可用的对照原图 <button type="button" class="product-retouch-link" data-retouch-retry-original data-node-read-action hidden>重新读取</button></p>
        <button type="button" class="product-retouch-link" data-retouch-action="error" data-node-read-action hidden>查看错误详情</button>
        <div class="product-retouch-footer-actions">
            <button type="button" class="product-retouch-inspect" aria-haspopup="dialog" data-retouch-action="preview-result" data-retouch-inspect data-node-read-action hidden>查看精修结果</button>
            <button type="button" class="btn btn-primary product-retouch-run" data-retouch-action="run" data-node-read-action>${retouchIcon}<span>开始精修</span></button>
        </div>`;
    const comparison = createProductRetouchComparison({ card, documentRef, openResultPreview,
        inspect: actions.querySelector('[data-retouch-inspect]'), hint: actions.querySelector('[data-retouch-comparison-status]') });
    (node.el._cleanupFns ||= []).push(comparison.destroy);
    const controls = [...element.querySelectorAll('[data-retouch-field]')];
    const model = element.querySelector('.product-retouch-model');
    const modelSelect = model.querySelector('[data-retouch-field="modelId"]');
    const providerSelect = model.querySelector('[data-retouch-field="providerId"]');
    const modelSummary = model.querySelector('summary span');
    const source = element.querySelector('.product-retouch-source-frame');
    const sourceCopy = source.querySelector('.product-retouch-source-copy');
    const sourceTitle = sourceCopy.querySelector('strong');
    const sourceStatus = sourceCopy.querySelector('span');
    const sourceIcon = source.querySelector('.product-retouch-source-icon');
    const sourcePreview = source.querySelector('[data-retouch-action="preview-source"]');
    const fileInput = source.querySelector('[data-retouch-upload]');
    const uploadButton = source.querySelector('[data-retouch-action="upload"]');
    const connections = element.querySelector('.product-retouch-connections');
    const status = actions.querySelector('p');
    const runButton = actions.querySelector('[data-retouch-action="run"]');
    const runLabel = runButton.querySelector('span');
    const errorButton = actions.querySelector('[data-retouch-action="error"]');
    const optionKeys = new WeakMap();
    let activeEdge = null;
    let uploading = false;
    let starting = false;
    let localMessage = '';
    let previousRunStatus = node.runStatus;
    connections.append(inputDetails);

    const setText = (target, value) => { if (target.textContent !== value) target.textContent = value; };
    const settings = () => normalizeProductRetouchSettings(node.data.productRetouch);

    function setOptions(select, entries, selected, placeholder) {
        const items = entries.map(item => [item.id, item.name || item.modelId || item.id]);
        if (selected && !items.some(([id]) => id === selected)) items.unshift([selected, '已选配置不可用']);
        const choices = [['', placeholder], ...items];
        const key = JSON.stringify(choices);
        if (optionKeys.get(select) !== key) {
            select.replaceChildren(...choices.map(([id, name]) => {
                const option = documentRef.createElement('option');
                option.value = id;
                option.textContent = name;
                return option;
            }));
            optionKeys.set(select, key);
        }
        if (select.value !== selected) select.value = selected;
    }

    function refresh() {
        const config = settings();
        const options = getProductRetouchModelOptions(state, config);
        const { groups, slots } = projectImageReferences({ state, targetId: node.id });
        const group = groups[0];
        const slot = slots[0];
        activeEdge = group?.connection || null;
        const validSource = groups.length === 1 && group.count === 1 && !!slot && !slot.missing;
        const thumbnail = validSource && !group.remote ? imageUrl(group.thumbnail || slot.image, slot.assetKey) : '';
        const sourceMessage = !group ? '上传图片，或从画布连接'
            : !group.source ? '来源已缺失'
                : !group.enabled ? '来源已停用'
                    : group.running ? '等待来源运行完成'
                        : group.count > 1 || groups.length > 1 ? '请选择单张商品图'
                            : group.missing || slot?.missing ? '参考图原图缺失'
                                : !validSource ? '来源尚无图片' : '已连接';
        const running = starting || state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus);
        const available = !running && !uploading && node.enabled !== false;
        const editable = available && !node.isClone;
        const canUpload = !group || (group.source?.type === 'ImageImport' && !group.source.isClone && group.enabled && !group.running && group.count === 0);
        updatePreview(sourcePreview, thumbnail);
        sourceIcon.hidden = !!thumbnail;
        source.dataset.ready = String(validSource);
        setText(sourceTitle, group?.name || '选择一张商品图');
        setText(sourceStatus, uploading ? '正在保存参考图…' : sourceMessage);
        uploadButton.hidden = !canUpload;
        uploadButton.disabled = !editable;
        fileInput.disabled = !editable || !canUpload;
        connections.hidden = !group;
        setOptions(modelSelect, options.models, config.modelId, '选择精修模型');
        setOptions(providerSelect, options.providers, config.providerId, '选择供应商');
        const selectedModel = options.models.find(item => item.id === config.modelId);
        setText(modelSummary, selectedModel?.name || selectedModel?.modelId || '');
        for (const control of controls) {
            const value = config[control.dataset.retouchField];
            if (control.type === 'radio') control.checked = control.value === value;
            else if (control !== documentRef.activeElement && control.value !== value) control.value = value;
            control.disabled = !editable || (control === providerSelect && !options.providers.length);
        }

        const missingResult = node.data.mediaIntegrity?.state === 'missing' || node.data.mediaIntegrity?.missingItems?.length > 0;
        const pair = readProductRetouchComparison(node);
        const resultUrl = missingResult ? '' : imageUrl(pair ? '' : getCanonicalImageList(node)[0],
            pair?.resultAssetKey || node.data.mediaAssetKeys?.[0]);
        const originalUrl = resultUrl && imageUrl('', pair?.originalAssetKey);
        comparison.update(resultUrl, originalUrl, node.runStatus === 'completed' && previousRunStatus !== 'completed');
        previousRunStatus = node.runStatus;
        emptyCard.hidden = !!resultUrl;
        runButton.disabled = !available || !validSource || !options.ready;
        setText(runLabel, running ? '精修中…' : resultUrl ? '重新精修' : '开始精修');
        const failure = node.runStatus === 'error' || node.isFailed === true;
        const feedback = running ? '正在处理商品图' : localMessage
            || (failure ? (resultUrl ? '精修失败，已保留上次结果' : '精修失败') : '')
            || (node.runStatus === 'aborted' ? '已取消精修' : '')
            || (!validSource ? (group ? sourceMessage : '请先添加商品参考图') : '')
            || (!options.ready ? (options.models.length ? '请选择精修模型和供应商' : '请配置支持参考图的精修模型') : '')
            || (missingResult ? '上次结果的原图缺失，可以重新精修' : '')
            || (resultUrl ? '已保存精修结果' : '');
        setText(status, feedback);
        status.dataset.error = String(!running && (failure || !!localMessage));
        errorButton.hidden = !failure || running || !node.executionFailure;
    }

    function updateSettings(event) {
        const field = event.target.dataset.retouchField;
        if (!field) return;
        const config = settings();
        const next = { ...config, [field]: event.target.value };
        if (field === 'modelId' && next.modelId !== config.modelId) {
            next.providerId = getProductRetouchModelOptions(state, next).providers[0]?.id || '';
        }
        node.data.productRetouch = normalizeProductRetouchSettings(next);
        localMessage = '';
    }
    element.addEventListener('input', updateSettings);
    element.addEventListener('change', updateSettings);
    model.open = !settings().modelId;
    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file || uploading) return;
        uploading = true;
        localMessage = '';
        refresh();
        try { await uploadReference(node, file); }
        catch (error) { localMessage = error.message || '参考图上传失败，请重试'; }
        finally { uploading = false; refresh(); }
    });
    sourcePreview.addEventListener('click', () => {
        if (activeEdge) openReferencePreview(activeEdge, () => sourcePreview.focus({ preventScroll: true }));
    });
    model.querySelector('[data-retouch-action="configure"]').addEventListener('click', () => {
        const { modelId, providerId } = settings();
        openModelSettings({ taskType: 'image', modelId, providerId, onClose: refresh });
    });
    errorButton.addEventListener('click', () => openNodeFailureLog(node.id));
    runButton.addEventListener('click', async () => {
        if (runButton.disabled) return;
        starting = true;
        localMessage = '';
        refresh();
        try {
            if (await run(node.id)) await waitForNodeRun(node.id);
        } catch (error) {
            localMessage = error.message || '无法开始精修，请重试';
        } finally {
            starting = false;
            refresh();
        }
    });
    return { element, actions, refresh };
}
