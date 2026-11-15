import {
    getProductRetouchAnalysisModelOptions, getProductRetouchModelOptions,
    normalizeProductRetouchSettings, readProductRetouchAnalysis
} from '../features/product-retouch/product-retouch-settings.js';
import { readProductRetouchComparison } from '../features/product-retouch/product-retouch-comparison.js';
import { getCanonicalImageList } from '../features/execution/execution-data-utils.js';
import { projectImageReferences } from './image-reference-projection.js';
import { createProductRetouchComparison, renderProductRetouchComparison } from './product-retouch-comparison-view.js';

const photoIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 16 5-5 5 5 3-3 5 5"/><circle cx="16" cy="9" r="1"/></svg>';
const uploadIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const retouchIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z"/></svg>';
const modelStages = [
    { taskType: 'chat', title: '图片分析', label: '视觉对话模型', modelField: 'analysisModelId', providerField: 'analysisProviderId',
        getOptions: getProductRetouchAnalysisModelOptions, missingModel: '请配置支持图片输入的视觉对话模型' },
    { taskType: 'image', title: '图片精修', label: '精修模型', modelField: 'modelId', providerField: 'providerId',
        getOptions: getProductRetouchModelOptions, missingModel: '请配置支持参考图的精修模型' }
];
const modelFields = new Set(modelStages.flatMap(({ modelField, providerField }) => [modelField, providerField]));
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

async function copyPrompt(documentRef, content) {
    const text = content.textContent;
    try {
        await documentRef.defaultView.navigator.clipboard.writeText(text);
        return true;
    } catch { /* Use a temporary text field when the browser clipboard API is unavailable. */ }
    const selection = documentRef.getSelection();
    if (!selection || content.textContent !== text || content.closest('[inert]') || typeof documentRef.execCommand !== 'function') return false;
    const originalRanges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    const originalFocus = documentRef.activeElement;
    const input = documentRef.createElement('textarea');
    input.value = text;
    input.readOnly = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    Object.assign(input.style, { position: 'fixed', inset: '0 auto auto 0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    try {
        documentRef.body.append(input);
        input.focus({ preventScroll: true });
        input.select();
        return documentRef.execCommand('copy');
    } catch {
        return false;
    } finally {
        input.remove();
        originalFocus?.focus({ preventScroll: true });
        selection.removeAllRanges();
        for (const original of originalRanges) selection.addRange(original);
    }
}

export function createProductRetouchView({
    node, state, documentRef, inputDetails, run, waitForNodeRun, uploadReference, openReferencePreview,
    openResultPreview, openModelSettings, openNodeFailureLog, onNativeClipboardWrite = () => {}
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
            <div class="product-retouch-model-stages">
                ${modelStages.map(({ taskType, title, label, modelField, providerField }) => `
                    <section class="product-retouch-model-stage" aria-labelledby="${panelId}-${taskType}">
                        <div class="product-retouch-model-stage-header">
                            <h3 id="${panelId}-${taskType}">${title}</h3>
                            <button type="button" class="product-retouch-link" data-retouch-action="configure" data-retouch-configure-task="${taskType}" aria-label="配置${label}">配置模型</button>
                        </div>
                        <div class="product-retouch-model-fields">
                            <label>${label}<select data-retouch-field="${modelField}"></select></label>
                            <label>供应商<select data-retouch-field="${providerField}" aria-label="${title}供应商"></select></label>
                        </div>
                    </section>`).join('')}
            </div>
        </details>
        <div class="product-retouch-analysis" hidden>
            <details class="product-retouch-disclosure" data-retouch-analysis>
                <summary>最近的分析提示词</summary>
                <pre tabindex="0" data-retouch-analysis-prompt aria-label="模型生成的精修提示词"></pre>
                <p data-retouch-analysis-empty hidden>未发现需要单独处理的细节</p>
            </details>
            <button type="button" class="product-retouch-link product-retouch-analysis-copy" data-retouch-action="copy-analysis" data-node-read-action>复制提示词</button>
            <span data-retouch-analysis-copy-status role="status"></span>
        </div>`;
    const actions = documentRef.createElement('div');
    actions.className = 'product-retouch-footer';
    actions.innerHTML = `<p role="status"></p>
        <p data-retouch-comparison-status hidden><span></span>
            <button type="button" class="product-retouch-link" data-retouch-retry-original data-node-read-action hidden>重新读取原图</button>
            <button type="button" class="product-retouch-link" data-retouch-retry-result data-node-read-action hidden>重新读取结果</button>
        </p>
        <button type="button" class="product-retouch-link" data-retouch-action="error" data-node-read-action hidden>查看错误详情</button>
        <div class="product-retouch-footer-actions">
            <button type="button" class="product-retouch-inspect" aria-haspopup="dialog" data-retouch-action="preview-result" data-retouch-inspect data-node-read-action hidden>查看精修结果</button>
            <button type="button" class="btn btn-primary product-retouch-run" data-retouch-action="run" data-node-read-action>${retouchIcon}<span>开始精修</span></button>
        </div>`;
    const comparison = createProductRetouchComparison({ card, documentRef, openResultPreview,
        inspect: actions.querySelector('[data-retouch-inspect]'), hint: actions.querySelector('[data-retouch-comparison-status]') });
    (node.el._cleanupFns ||= []).push(comparison.destroy);
    const controls = [...element.querySelectorAll('[data-retouch-field]')].filter(control => !modelFields.has(control.dataset.retouchField));
    const model = element.querySelector('.product-retouch-model');
    const modelControls = modelStages.map(stage => ({ ...stage,
        modelSelect: model.querySelector(`[data-retouch-field="${stage.modelField}"]`),
        providerSelect: model.querySelector(`[data-retouch-field="${stage.providerField}"]`),
        configure: model.querySelector(`[data-retouch-configure-task="${stage.taskType}"]`)
    }));
    const modelSummary = model.querySelector('summary span');
    const analysis = element.querySelector('.product-retouch-analysis');
    const analysisSummary = analysis.querySelector('summary');
    const analysisPrompt = analysis.querySelector('[data-retouch-analysis-prompt]');
    const analysisEmpty = analysis.querySelector('[data-retouch-analysis-empty]');
    const copyAnalysis = analysis.querySelector('[data-retouch-action="copy-analysis"]');
    const copyStatus = analysis.querySelector('[data-retouch-analysis-copy-status]');
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
        for (const control of controls) {
            const value = config[control.dataset.retouchField];
            if (control.type === 'radio') control.checked = control.value === value;
            else if (control !== documentRef.activeElement && control.value !== value) control.value = value;
            control.disabled = !editable;
        }
        let modelIssue = '';
        const configuredModels = [];
        for (const stage of modelControls) {
            const options = stage.getOptions(state, config);
            setOptions(stage.modelSelect, options.models, config[stage.modelField], `选择${stage.label}`);
            setOptions(stage.providerSelect, options.providers, config[stage.providerField], '选择供应商');
            stage.modelSelect.disabled = !editable;
            stage.providerSelect.disabled = !editable || !options.providers.length;
            if (!options.ready) modelIssue ||= options.models.length ? `请选择${stage.label}和供应商` : stage.missingModel;
            const selected = options.models.find(item => item.id === config[stage.modelField]);
            if (selected) configuredModels.push(selected.name || selected.modelId || selected.id);
        }
        const summary = modelIssue ? '待配置' : configuredModels.join(' · ');
        setText(modelSummary, summary);
        if (modelSummary.title !== summary) modelSummary.title = summary;

        const latestAnalysis = readProductRetouchAnalysis(node);
        const prompt = latestAnalysis?.prompt || '';
        const focusedAnalysisControl = [analysisPrompt, copyAnalysis].includes(documentRef.activeElement);
        if (analysisPrompt.textContent !== prompt) {
            setText(analysisPrompt, prompt);
            setText(copyStatus, '');
        }
        analysis.hidden = !latestAnalysis;
        analysisPrompt.hidden = !prompt;
        analysisEmpty.hidden = Boolean(prompt);
        copyAnalysis.hidden = !prompt;
        if (latestAnalysis && !prompt && focusedAnalysisControl) analysisSummary.focus({ preventScroll: true });

        const missingResult = node.data.mediaIntegrity?.state === 'missing' || node.data.mediaIntegrity?.missingItems?.length > 0;
        const pair = readProductRetouchComparison(node);
        const resultUrl = missingResult ? '' : imageUrl(pair ? '' : getCanonicalImageList(node)[0],
            pair?.resultAssetKey || node.data.mediaAssetKeys?.[0]);
        const originalUrl = resultUrl && imageUrl('', pair?.originalAssetKey);
        comparison.update(resultUrl, originalUrl, node.runStatus === 'completed' && previousRunStatus !== 'completed');
        previousRunStatus = node.runStatus;
        emptyCard.hidden = !!resultUrl;
        runButton.disabled = !available || !validSource || !!modelIssue;
        runButton.setAttribute('aria-busy', String(running));
        const analyzing = node.productRetouchStage === 'analyzing';
        const retouching = node.productRetouchStage === 'retouching';
        const runningLabel = analyzing ? '分析中…' : retouching ? '精修中…' : '准备中…';
        const runningMessage = analyzing ? '正在分析商品参考图…' : retouching ? '正在精修商品图…' : '正在准备精修…';
        setText(runLabel, running ? runningLabel : resultUrl ? '重新精修' : '开始精修');
        const failure = node.runStatus === 'error' || node.isFailed === true;
        const feedback = running ? runningMessage : localMessage
            || (failure ? (resultUrl ? '精修失败，已保留上次结果' : '精修失败') : '')
            || (node.runStatus === 'aborted' ? '已取消精修' : '')
            || (!validSource ? (group ? sourceMessage : '请先添加商品参考图') : '')
            || modelIssue
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
        const stage = modelStages.find(candidate => candidate.modelField === field);
        if (stage && next[field] !== config[field]) {
            const { providers } = stage.getOptions(state, next);
            if (!providers.some(provider => provider.id === config[stage.providerField])) {
                next[stage.providerField] = stage.taskType === 'image' || providers.length === 1 ? providers[0]?.id || '' : '';
            }
        }
        node.data.productRetouch = normalizeProductRetouchSettings(next);
        localMessage = '';
    }
    element.addEventListener('input', updateSettings);
    element.addEventListener('change', updateSettings);
    const initialSettings = settings();
    model.open = modelStages.some(stage => !stage.getOptions(state, initialSettings).ready);
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
    for (const { configure, taskType, modelField, providerField } of modelControls) {
        configure.addEventListener('click', () => {
            const config = settings();
            openModelSettings({ taskType, modelId: config[modelField], providerId: config[providerField], onClose: refresh });
        });
    }
    copyAnalysis.addEventListener('click', async () => {
        const prompt = analysisPrompt.textContent;
        const copied = await copyPrompt(documentRef, analysisPrompt);
        if (copied) onNativeClipboardWrite();
        if (analysisPrompt.textContent === prompt) setText(copyStatus, copied ? '已复制' : '复制失败，可选中文字复制');
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
