import {
    COMMERCE_IMAGE_SET_ASPECTS, COMMERCE_IMAGE_SET_COPY_LANGUAGES, COMMERCE_IMAGE_SET_COPY_LIMITS,
    COMMERCE_IMAGE_SET_DEFAULT_ASPECTS, COMMERCE_IMAGE_SET_PRESETS, COMMERCE_PRODUCT_INFO_LIMITS, COMMERCE_SCENE_DESCRIPTION_LIMIT,
    appendCommerceSceneShot, confirmCommerceSceneShot, getCommerceProductInfo, getRunnableCommerceImageSetShots,
    getSelectedCommerceImageSetShots, getUnfinishedCommerceImageSetShots, isCommerceShotImageStale, normalizeCommerceImageSetCopyLanguage,
    preserveCommerceImageSetExportResults, updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField, updateCommerceSceneDescription
} from '../features/ecommerce-image-set/commerce-image-set-plan.js';
import { hasCommerceImageSetExportMedia, projectCommerceImageSetExport } from '../features/ecommerce-image-set/commerce-image-set-export.js';
import { openCommerceImageSetExport } from '../features/ecommerce-image-set/commerce-image-set-export-dialog.js';
import { getEffectiveProtocol, getModelProviders, getModelsForTask } from '../features/execution/provider-request-utils.js';
import { getOpenAIChatCapabilities } from '../features/execution/openai-chat-capabilities.js';
import { projectImageReferences } from './image-reference-projection.js';

const shotGroups = [['gallery', '主副图'], ['detail', '详情图']];
const selectControl = (field, label = '') => `<select class="ui-select" data-commerce-field="${field}"${label ? ` aria-label="${label}"` : ''}></select>`;
const stopIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const addIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const exportIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/></svg>';
const isActiveShot = status => ['pending', 'running', 'planning'].includes(status);
let panelSequence = 0;

export function renderCommerceImageSetBody() {
    return `<div class="commerce-image-set-card">
        <img class="commerce-image-set-cover" alt="套图预览" hidden>
        <span class="commerce-image-set-card-title">电商套图</span>
        <span class="commerce-image-set-card-progress"></span>
    </div>`;
}

function assetUrl(key) {
    return typeof key === 'string' && key.startsWith('media:') ? `/api/storage/assets/${encodeURIComponent(key)}` : '';
}

function setImage(element, url) {
    if (url && element.getAttribute('src') !== url) element.src = url;
    if (!url) element.removeAttribute('src');
    element.hidden = !url;
}

export function createCommerceImageSetView({ node, state, documentRef, run, cancel, onChange, openResultPreview, openShotError, bindReferencePrompt }) {
    const card = node.el.querySelector('.commerce-image-set-card');
    const cover = card.querySelector('img');
    const cardTitle = card.querySelector('.commerce-image-set-card-title');
    const cardProgress = card.querySelector('.commerce-image-set-card-progress');
    const panelId = `commerce-image-set-${++panelSequence}`;
    const editorIdPrefix = `${panelId}-shot`;
    const element = documentRef.createElement('section');
    element.className = 'commerce-image-set-settings';
    element.innerHTML = `<section class="commerce-image-set-product" aria-labelledby="${panelId}-product-heading">
        <header class="commerce-image-set-product-header">
            <h3 id="${panelId}-product-heading" tabindex="-1">产品信息</h3>
            <button type="button" class="commerce-image-set-analyze" data-commerce-action="analyze" aria-describedby="${panelId}-product-hint">
                <svg class="commerce-image-set-analyze-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M7 12h10"/><path d="M10 8h4m-4 8h4"/></svg>
                <span class="commerce-image-set-analyze-spinner functional-animation" aria-hidden="true"></span>
                <span class="commerce-image-set-analyze-label">分析产品</span>
            </button>
        </header>
        <p class="commerce-image-set-product-hint" id="${panelId}-product-hint" role="status">可选填。生成方案时，AI 会根据参考图补全。</p>
        <div class="commerce-image-set-product-fields">
            <label>产品名称<input type="text" data-commerce-product-field="name" maxlength="${COMMERCE_PRODUCT_INFO_LIMITS.name}" placeholder="填写名称或由 AI 识别"></label>
            <label>核心卖点<textarea data-commerce-product-field="sellingPoints" data-commerce-selling-points rows="2" maxlength="${(COMMERCE_PRODUCT_INFO_LIMITS.sellingPoint + 1) * COMMERCE_PRODUCT_INFO_LIMITS.sellingPoints - 1}" placeholder="每行一条，最多 ${COMMERCE_PRODUCT_INFO_LIMITS.sellingPoints} 条"></textarea></label>
        </div>
        <details class="commerce-image-set-disclosure commerce-image-set-product-more">
            <summary>人群、场景与规格<span class="commerce-image-set-product-extra" hidden></span></summary>
            <div class="commerce-image-set-product-fields">
                <label>适用人群<textarea data-commerce-product-field="audience" rows="2" maxlength="${COMMERCE_PRODUCT_INFO_LIMITS.audience}" placeholder="如日常通勤人群"></textarea></label>
                <label>使用场景<textarea data-commerce-product-field="useCases" rows="2" maxlength="${COMMERCE_PRODUCT_INFO_LIMITS.useCases}" placeholder="如办公室、户外运动"></textarea></label>
                <label>产品细节与规格<textarea data-commerce-product-field="details" rows="3" maxlength="${COMMERCE_PRODUCT_INFO_LIMITS.details}" placeholder="补充材质、尺寸、配件或其他产品信息"></textarea></label>
            </div>
        </details>
    </section>
    <details class="commerce-image-set-setup" open>
        <summary><strong>生成设置</strong><span></span></summary>
        <div class="commerce-image-set-setup-fields">
            <div class="commerce-image-set-platform">
                <label>平台${selectControl('platformId')}</label>
                <p class="commerce-image-set-guide"></p>
                <label>图中文字语言${selectControl('copyLanguage')}</label>
            </div>
            <div class="commerce-image-set-selection">
                ${shotGroups.map(([group, title]) => `<section class="commerce-image-set-choice-group">
                    <div class="commerce-image-set-group-heading">
                        <h3>${title}</h3>
                        <label>比例${selectControl(`${group}Aspect`, `${title}比例`)}</label>
                    </div>
                    <div class="commerce-image-set-shot-choices" data-commerce-choice-group="${group}" role="group" aria-label="${title}图位"></div>
                </section>`).join('')}
                <p class="commerce-image-set-selection-hint" role="status">请至少勾选一个图位。</p>
            </div>
        </div>
    </details>
    <details class="node-model-settings">
        <summary class="node-model-settings-heading">模型与供应商</summary>
        <div class="commerce-image-set-options">
            <div class="node-model-settings-fields">
                <label>规划模型${selectControl('plannerModelId')}</label>
                <label>规划供应商${selectControl('plannerProviderId')}</label>
            </div>
            <div class="node-model-settings-fields">
                <label>生图模型${selectControl('imageModelId')}</label>
                <label>生图供应商${selectControl('imageProviderId')}</label>
            </div>
        </div>
    </details>
    <section class="commerce-image-set-plan" aria-label="套图方案" hidden>
        <header class="commerce-image-set-plan-heading">
            <h3>套图方案</h3>
            <button type="button" class="commerce-image-set-export-trigger" data-commerce-action="export" data-node-read-action aria-haspopup="dialog" hidden>${exportIcon}<span>导出套图</span></button>
        </header>
        <div class="commerce-image-set-shots">
            ${shotGroups.map(([group, title]) => `<section class="commerce-image-set-result-group" data-commerce-result-group="${group}">
                <header class="commerce-image-set-group-heading">
                    <div class="commerce-image-set-result-title"><h4>${title}</h4><span class="commerce-image-set-result-count"></span></div>
                    <button type="button" class="commerce-image-set-add-scene" data-commerce-action="add-scene" data-commerce-scene-group="${group}" aria-label="添加${title}场景图">${addIcon}<span>添加场景图</span></button>
                </header>
            </section>`).join('')}
        </div>
    </section>`;
    const actions = documentRef.createElement('div');
    actions.className = 'commerce-image-set-footer';
    actions.innerHTML = `<div class="commerce-image-set-run-summary">
            <p class="commerce-image-set-status" role="status" tabindex="-1"></p>
            <button type="button" class="commerce-image-set-stop" data-commerce-action="cancel-all" hidden>${stopIcon}<span>取消全部</span></button>
        </div>
        <progress class="commerce-image-set-progress" aria-label="套图生成进度" hidden></progress>
        <div class="commerce-image-set-actions">
            <button type="button" class="btn btn-primary" data-commerce-action="plan">生成方案</button>
            <button type="button" class="btn btn-primary" data-commerce-action="generate" hidden>确认并生成套图</button>
            <button type="button" class="btn btn-primary" data-commerce-action="fill" hidden>补齐图位</button>
        </div>`;
    const fields = Object.fromEntries(Array.from(element.querySelectorAll('[data-commerce-field]'), control => [control.dataset.commerceField, control]));
    const productFields = Array.from(element.querySelectorAll('[data-commerce-product-field]'));
    const productHeading = element.querySelector('.commerce-image-set-product-header h3');
    const productHint = element.querySelector('.commerce-image-set-product-hint');
    const productMore = element.querySelector('.commerce-image-set-product-more');
    const productExtra = productMore.querySelector('.commerce-image-set-product-extra');
    const analyzeButton = element.querySelector('[data-commerce-action="analyze"]');
    const analyzeLabel = analyzeButton.querySelector('.commerce-image-set-analyze-label');
    const setup = element.querySelector('.commerce-image-set-setup');
    const setupSummary = setup.querySelector('summary');
    const setupSelection = setupSummary.querySelector('span');
    const guide = element.querySelector('.commerce-image-set-guide');
    const shotSelection = element.querySelector('.commerce-image-set-selection');
    const choiceGroups = new Map(shotGroups.map(([group]) => [group, shotSelection.querySelector(`[data-commerce-choice-group="${group}"]`)]));
    const shotSelectionHint = shotSelection.querySelector('.commerce-image-set-selection-hint');
    const planSection = element.querySelector('.commerce-image-set-plan');
    const planHeading = planSection.querySelector('h3');
    const exportButton = planSection.querySelector('[data-commerce-action="export"]');
    const shots = element.querySelector('.commerce-image-set-shots');
    const resultGroups = new Map(shotGroups.map(([group]) => {
        const section = shots.querySelector(`[data-commerce-result-group="${group}"]`);
        return [group, { header: section.firstElementChild,
            count: section.querySelector('.commerce-image-set-result-count'),
            add: section.querySelector('[data-commerce-action="add-scene"]') }];
    }));
    const planButton = actions.querySelector('[data-commerce-action="plan"]');
    const generateButton = actions.querySelector('[data-commerce-action="generate"]');
    const fillButton = actions.querySelector('[data-commerce-action="fill"]');
    const cancelAllButton = actions.querySelector('[data-commerce-action="cancel-all"]');
    const status = actions.querySelector('.commerce-image-set-status');
    const progressBar = actions.querySelector('progress');
    const actionButtons = actions.querySelector('.commerce-image-set-actions');
    const defaultPlatformId = Object.keys(COMMERCE_IMAGE_SET_PRESETS)[0];
    const config = () => (node.data.commerceImageSet ??= { platformId: defaultPlatformId, selectedShotIds: [] });
    const shotRows = new Map();
    const optionKeys = new WeakMap();
    const pendingShots = new Map();
    const shotNotices = new Map();
    const cancelingShots = new Set();
    let pendingAction = null;
    let cancelingAll = false;
    let runMessage = '';
    let productMessage = '';
    let choicePlatform = '';
    let activeShotId = '';
    let planSourceKey = null;
    let closeExportDialog = null;

    function setOptions(control, entries, selected, placeholder) {
        const key = JSON.stringify(entries);
        if (optionKeys.get(control) !== key) {
            const choices = (placeholder ? [['', placeholder], ...entries] : entries).map(([value, label]) => {
                const option = documentRef.createElement('option');
                option.value = value;
                option.textContent = label;
                return option;
            });
            control.replaceChildren(...choices);
            optionKeys.set(control, key);
        }
        if (control.value !== (selected || '')) control.value = selected || '';
    }

    function modelOptions(task, modelId, providerId) {
        const providers = state.providers || [];
        const models = getModelsForTask(state.models || [], task).filter(model => getModelProviders(model, providers).some(provider => (
            task !== 'chat' || (model.capabilities?.imageInput !== false
                && getOpenAIChatCapabilities({ model, provider, protocol: getEffectiveProtocol(model, provider) })?.imageInput !== false)
        )));
        const selected = models.find(model => model.id === modelId);
        const compatible = selected ? getModelProviders(selected, providers).filter(provider => (
            task !== 'chat' || getOpenAIChatCapabilities({ model: selected, provider, protocol: getEffectiveProtocol(selected, provider) })?.imageInput !== false
        )) : [];
        return { models, providers: compatible, ready: compatible.some(provider => provider.id === providerId) };
    }

    function renderShotChoices(preset, selectedShots, locked) {
        if (choicePlatform !== preset.id) {
            for (const [group, container] of choiceGroups) {
                const choices = preset.shots.filter(shot => (shot.group || 'gallery') === group).map(shot => {
                    const label = documentRef.createElement('label');
                    const checkbox = documentRef.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.dataset.commerceSelectShot = shot.id;
                    const name = documentRef.createElement('span');
                    name.textContent = shot.label;
                    const control = documentRef.createElement('span');
                    control.className = 'toggle-switch toggle-switch-compact';
                    const track = documentRef.createElement('span');
                    track.className = 'toggle-slider';
                    track.setAttribute('aria-hidden', 'true');
                    control.append(checkbox, track);
                    label.append(name, control);
                    return label;
                });
                container.replaceChildren(...choices);
            }
            choicePlatform = preset.id;
        }
        const selected = new Set(selectedShots.map(shot => shot.id));
        for (const checkbox of shotSelection.querySelectorAll('[data-commerce-select-shot]')) {
            checkbox.checked = selected.has(checkbox.dataset.commerceSelectShot);
            checkbox.disabled = locked;
        }
        shotSelectionHint.hidden = selected.size > 0;
    }

    function makeShotRow(shot) {
        const row = documentRef.createElement('article');
        row.className = 'commerce-image-set-shot';
        row.dataset.commerceShotId = shot.id;
        row.toggleAttribute('data-commerce-scene-shot', shot.customScene === true);
        row.tabIndex = -1;
        row.innerHTML = `<div class="commerce-image-set-shot-summary">
            <button type="button" class="commerce-image-set-shot-preview" data-commerce-action="preview" data-node-read-action aria-pressed="false" hidden><img loading="lazy" hidden></button>
            <div class="commerce-image-set-shot-info">
                <button type="button" class="commerce-image-set-shot-toggle" data-node-read-action aria-expanded="false">
                    <span class="commerce-image-set-shot-heading"><span class="commerce-image-set-shot-name"><span class="commerce-image-set-shot-chevron" aria-hidden="true"></span><strong></strong></span><span class="commerce-image-set-shot-aspect"></span></span>
                </button>
                <div class="commerce-image-set-shot-status-slot">
                    <span class="commerce-image-set-shot-status" role="status"></span>
                    <button type="button" class="image-parameter-failure-button" data-commerce-action="error-detail"
                        data-node-read-action aria-haspopup="dialog" title="查看错误详情" hidden>生成失败</button>
                </div>
                <div class="commerce-image-set-shot-tools" hidden>
                    ${shot.customScene ? '' : `<button type="button" class="commerce-image-set-shot-action" data-commerce-action="replan-shot">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v2M13 3v5h5M8 12h4M8 16h2"/><path d="m13 17 5.5-5.5a1.4 1.4 0 0 1 2 2L15 19l-3 1z"/></svg>
                    </button>
                    <button type="button" class="commerce-image-set-shot-action" data-commerce-action="retry" data-node-read-action>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5M3 16l4-4 3 3 3-3"/><circle cx="8" cy="8" r="1"/><path d="M21 14v4h-4m4 0a4 4 0 1 0-1.1 3.2"/></svg>
                    </button>`}
                    <button type="button" class="commerce-image-set-stop" data-commerce-action="cancel-shot" hidden>${stopIcon}<span>取消</span></button>
                </div>
                <p class="commerce-image-set-version-note" role="status" hidden></p>
                ${shot.customScene ? '<p class="commerce-image-set-scene-summary" hidden></p>' : ''}
                <span class="commerce-image-set-copy-summary" hidden></span>
                <p class="commerce-image-set-shot-notice" role="status" hidden></p>
            </div>
        </div>
        <div class="commerce-image-set-shot-editor" hidden>
            ${shot.customScene ? `<label>场景描述（选填）<textarea data-commerce-shot-field="description" rows="2" maxlength="${COMMERCE_SCENE_DESCRIPTION_LIMIT}" placeholder="留空由 AI 推荐"></textarea></label>`
                : '<p class="commerce-image-set-shot-purpose" hidden></p>'}
            ${shot.source === 'generate' ? `<div class="commerce-image-set-copy-fields">
                <label>图中文字标题<input type="text" data-commerce-shot-field="headline" maxlength="${COMMERCE_IMAGE_SET_COPY_LIMITS.headline}"></label>
                <label>图中文字正文<textarea data-commerce-shot-field="body" rows="2" maxlength="${COMMERCE_IMAGE_SET_COPY_LIMITS.body}"></textarea></label>
            </div>
            <label>生图提示词<textarea data-commerce-shot-field="prompt" rows="3" maxlength="2000"></textarea></label>` : ''}
            ${shot.customScene ? `<div class="commerce-image-set-scene-actions">
                <button type="button" class="btn" data-commerce-action="replan-shot">生成方案</button>
                <button type="button" class="btn btn-primary" data-commerce-action="retry" hidden>确认并生图</button>
            </div>` : ''}
        </div>`;
        row.querySelector('strong').textContent = shot.label;
        row.querySelector('.commerce-image-set-shot-aspect').textContent = shot.source === 'reference' ? '沿用第一张参考图' : (shot.aspect || '');
        const editor = row.querySelector('.commerce-image-set-shot-editor');
        const toggle = row.querySelector('.commerce-image-set-shot-toggle');
        const message = row.querySelector('.commerce-image-set-shot-status');
        const versionNote = row.querySelector('.commerce-image-set-version-note');
        const failure = row.querySelector('[data-commerce-action="error-detail"]');
        failure.setAttribute('aria-label', `查看「${shot.label}」生成失败详情`);
        editor.id = `${editorIdPrefix}-${shot.id}`;
        message.id = `${editor.id}-status`;
        versionNote.id = `${editor.id}-image-version`;
        toggle.setAttribute('aria-controls', editor.id);
        toggle.setAttribute('aria-describedby', `${message.id} ${versionNote.id}`);
        toggle.setAttribute('aria-label', shot.label);
        const purpose = editor.querySelector('.commerce-image-set-shot-purpose');
        const copyFields = editor.querySelector('.commerce-image-set-copy-fields');
        const shotFields = Array.from(editor.querySelectorAll('[data-commerce-shot-field]'));
        const prompt = editor.querySelector('[data-commerce-shot-field="prompt"]');
        const destroyPrompt = bindReferencePrompt?.(node, prompt);
        const image = row.querySelector('img');
        image.alt = shot.label;
        const preview = row.querySelector('[data-commerce-action="preview"]');
        preview.setAttribute('aria-label', `打开${shot.label}预览`);
        preview.setAttribute('aria-describedby', versionNote.id);
        row.querySelector('.commerce-image-set-shot-tools').hidden = shot.source !== 'generate';
        const replan = row.querySelector('[data-commerce-action="replan-shot"]');
        replan.title = `重新生成${shot.label}方案`;
        replan.setAttribute('aria-label', replan.title);
        const retry = row.querySelector('[data-commerce-action="retry"]');
        const cancelShot = row.querySelector('[data-commerce-action="cancel-shot"]');
        cancelShot.setAttribute('aria-label', `取消「${shot.label}」`);
        row.addEventListener('click', event => {
            if (event.target.closest('[data-commerce-action], .commerce-image-set-shot-editor')) return;
            expandShotEditor(editor.hidden ? shot.id : null);
        });
        return { row, editor, toggle, purpose, copyFields, promptLabel: prompt?.closest('label'),
            shotFields, image, preview, replan, retry, cancelShot, failure, destroyPrompt,
            sceneSummary: row.querySelector('.commerce-image-set-scene-summary'),
            message, versionNote, notice: row.querySelector('.commerce-image-set-shot-notice'),
            tools: row.querySelector('.commerce-image-set-shot-tools'),
            copySummary: row.querySelector('.commerce-image-set-copy-summary') };
    }

    function expandShotEditor(shotId) {
        for (const [id, item] of shotRows) {
            const expanded = id === shotId;
            if (item.editor.hidden === !expanded) continue;
            item.editor.hidden = !expanded;
            item.toggle.setAttribute('aria-expanded', String(expanded));
        }
    }

    function getShotPreview(shotId) {
        return node.commerceShotPreviews?.[shotId];
    }

    function shotTaskStatus(shotId) {
        const task = node.commerceShotTasks?.[shotId];
        const preview = getShotPreview(shotId)?.status;
        const pending = pendingShots.get(shotId);
        if (isActiveShot(task)) {
            if (pending) pending.observed = true;
            return task;
        }
        if (isActiveShot(preview)) return preview;
        return (pending && !pending.observed ? pending.status : null) || preview || task;
    }

    function clearShotRows() {
        for (const row of shotRows.values()) row.destroyPrompt?.();
        shotRows.clear();
    }

    function syncShotRows(planShots, canAppendScene) {
        const shotsById = new Map(planShots.map(shot => [shot.id, shot]));
        const structureKey = ({ label, aspect, source, customScene }) => JSON.stringify([label, aspect, source, customScene]);
        for (const [id, row] of shotRows) {
            const shot = shotsById.get(id);
            if (shot && row.structureKey === structureKey(shot)) continue;
            row.destroyPrompt?.();
            row.row.remove();
            shotRows.delete(id);
        }
        for (const [group, { header, count, add }] of resultGroups) {
            const groupShots = planShots.filter(shot => (shot.group || 'gallery') === group);
            const countText = groupShots.length ? `${groupShots.length} 张` : '';
            if (count.textContent !== countText) count.textContent = countText;
            add.disabled = !canAppendScene;
            let previous = header;
            for (const shot of groupShots) {
                let row = shotRows.get(shot.id);
                if (!row) {
                    row = makeShotRow(shot);
                    row.structureKey = structureKey(shot);
                    shotRows.set(shot.id, row);
                }
                if (row.row !== previous.nextElementSibling) previous.after(row.row);
                previous = row.row;
            }
        }
    }

    function renderShots(plan, results, { locked, readyToReplan, canRetry, canAppendScene, shownShotId }) {
        const planShots = plan?.shots || [];
        syncShotRows(planShots, canAppendScene);
        const savedResults = new Map(results.map(result => [result.shotId, result]));
        for (const shot of planShots) {
            const row = shotRows.get(shot.id);
            const savedResult = savedResults.get(shot.id);
            const liveResult = getShotPreview(shot.id);
            const result = liveResult || savedResult;
            const task = shotTaskStatus(shot.id);
            const active = isActiveShot(task);
            if (!active) cancelingShots.delete(shot.id);
            else shotNotices.delete(shot.id);
            const canceling = active && (cancelingAll || cancelingShots.has(shot.id));
            const notice = shotNotices.get(shot.id);
            const restoreFocus = !active && documentRef.activeElement === row.cancelShot;
            const scenePlanned = !!shot.sceneSummary;
            if (row.purpose) {
                if (row.purpose.textContent !== (shot.purpose || '')) row.purpose.textContent = shot.purpose || '';
                row.purpose.hidden = !shot.purpose;
            }
            if (row.sceneSummary) {
                const sceneSummary = shot.sceneSummary || '';
                if (row.sceneSummary.textContent !== sceneSummary) row.sceneSummary.textContent = sceneSummary;
                row.sceneSummary.hidden = !scenePlanned;
                row.promptLabel.hidden = !scenePlanned;
            }
            if (row.copyFields) row.copyFields.hidden = !shot.allowCopy || (shot.customScene && !scenePlanned);
            for (const field of row.shotFields) {
                if (documentRef.activeElement !== field) field.value = shot[field.dataset.commerceShotField] || '';
                field.disabled = locked || active;
            }
            const copy = shot.allowCopy ? [shot.headline, shot.body].filter(Boolean).join(' · ') : '';
            if (row.copySummary.textContent !== copy) row.copySummary.textContent = copy;
            row.copySummary.hidden = !copy || shot.customScene === true;
            const previewResult = liveResult?.image ? liveResult : savedResult;
            const previewUrl = previewResult?.image || assetUrl(previewResult?.assetKey);
            setImage(row.image, previewUrl);
            row.preview.hidden = !previewUrl;
            row.preview.setAttribute('aria-pressed', String(shownShotId === shot.id));
            const staleImage = !!previewUrl && isCommerceShotImageStale(shot, previewResult);
            if (row.versionNote.hidden === staleImage) {
                row.versionNote.hidden = !staleImage;
                row.versionNote.textContent = staleImage ? '方案已更新 · 当前为上一版' : '';
            }
            const failed = result?.status === 'failed';
            const sceneStatus = shot.customScene && !shot.sceneConfirmed ? (scenePlanned ? 'review' : 'unplanned') : null;
            const resultStatus = canceling ? 'canceling' : task === 'pending' ? 'queued'
                : active || task === 'canceled' ? task : notice?.status || sceneStatus || result?.status || 'pending';
            const message = {
                planning: '正在规划', running: '正在生成', queued: '等待生成', canceling: '正在取消',
                canceled: '已取消', failed: '生成失败', completed: '已完成', 'plan-failed': '方案生成失败',
                'retry-failed': '生图未完成', unplanned: '待规划', review: '待确认'
            }[resultStatus] || (shot.source === 'reference' ? '待应用' : '待生成');
            if (row.message.textContent !== message) row.message.textContent = message;
            row.row.dataset.resultStatus = resultStatus;
            row.message.hidden = resultStatus === 'failed';
            row.failure.hidden = resultStatus !== 'failed';
            row.replan.disabled = locked || active || !readyToReplan;
            row.retry.disabled = locked || active || !canRetry || !shot.prompt?.trim();
            row.tools.hidden = !active && (shot.customScene || shot.source !== 'generate');
            row.replan.hidden = shot.customScene ? false : active || shot.source !== 'generate';
            row.retry.hidden = shot.customScene ? !scenePlanned : active || shot.source !== 'generate';
            row.cancelShot.setAttribute('aria-disabled', String(canceling));
            row.cancelShot.hidden = !active;
            const noticeText = active ? '' : notice?.text || '';
            if (row.notice.textContent !== noticeText) row.notice.textContent = noticeText;
            row.notice.hidden = !noticeText;
            let label = `${savedResult?.status === 'completed' ? '重新生成' : failed ? '重试' : '生成'}${shot.label}图片`;
            if (shot.customScene) {
                const replanText = scenePlanned ? '重新规划' : '生成方案';
                const generateText = shot.sceneConfirmed ? (savedResult?.assetKey ? '重新生成图片' : '生成图片') : '确认并生图';
                if (row.replan.textContent !== replanText) row.replan.textContent = replanText;
                const replanLabel = `${replanText}「${shot.label}」`;
                if (row.replan.title !== replanLabel) {
                    row.replan.title = replanLabel;
                    row.replan.setAttribute('aria-label', replanLabel);
                }
                row.replan.classList.toggle('btn-primary', !scenePlanned);
                row.replan.classList.toggle('btn-secondary', scenePlanned);
                if (row.retry.textContent !== generateText) row.retry.textContent = generateText;
                label = `${generateText}「${shot.label}」`;
            }
            if (row.retry.title !== label) {
                row.retry.title = label;
                row.retry.setAttribute('aria-label', label);
            }
            if (restoreFocus) {
                const pending = pendingShots.get(shot.id);
                const action = pending?.status === 'planning' ? row.replan : row.retry;
                let target = row.toggle;
                if (!action.hidden && !action.disabled && (!shot.customScene || !row.editor.hidden)) target = action;
                else if (pending && locked) target = row.row;
                target.focus({ preventScroll: true });
            }
        }
    }

    function refresh() {
        const value = config();
        const platformId = Object.hasOwn(COMMERCE_IMAGE_SET_PRESETS, value.platformId) ? value.platformId : defaultPlatformId;
        const preset = COMMERCE_IMAGE_SET_PRESETS[platformId];
        const copyLanguage = normalizeCommerceImageSetCopyLanguage(value.copyLanguage);
        const selectedShots = getSelectedCommerceImageSetShots(value);
        const selectedPresetShots = selectedShots.filter(shot => !shot.customScene);
        const runnableShots = getRunnableCommerceImageSetShots(value);
        const needsImageModel = runnableShots.some(shot => shot.source === 'generate');
        const planner = modelOptions('chat', value.plannerModelId, value.plannerProviderId);
        const image = modelOptions('image', value.imageModelId, value.imageProviderId);
        const references = projectImageReferences({ state, targetId: node.id });
        const referenceIssue = references.count > 5 ? '套图最多使用 5 张参考图，请调整输入。'
            : references.groups.some(group => group.running) ? '请等待参考图来源运行完成。'
            : !references.count || references.slots.some(slot => slot.missing) ? '请连接 1 至 5 张可读取的商品参考图。' : '';
        const plan = value.plan;
        const activeShots = plan?.shots.filter(shot => isActiveShot(shotTaskStatus(shot.id))) || [];
        const activeShotLabel = activeShots.length ? `${activeShots.length} 个图位进行中` : '';
        const hasIndependentTasks = activeShots.some(({ id }) => isActiveShot(node.commerceShotTasks?.[id])
            || pendingShots.get(id)?.observed === false);
        const busy = !!(pendingAction || activeShots.length || state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus));
        if (!busy) cancelingAll = false;
        const unavailable = node.enabled === false || node.isClone === true;
        const locked = busy || unavailable;
        const shotsLocked = unavailable || cancelingAll || (busy && !activeShots.length && !node.commerceShotPreviews)
            || ['analyze', 'plan'].includes(pendingAction?.action);
        const copyLanguageChanged = !!plan && (plan.copyLanguage ?? 'auto') !== copyLanguage;
        if ((plan?.sourceKey ?? null) !== planSourceKey) {
            planSourceKey = plan?.sourceKey ?? null;
            activeShotId = '';
            shotNotices.clear();
            setup.open = !plan?.sourceKey || copyLanguageChanged;
        }
        const selectionLabel = `${preset.label} · ${selectedShots.length} 个图位`;
        if (setupSelection.textContent !== selectionLabel) setupSelection.textContent = selectionLabel;
        const results = Array.isArray(value.results) ? value.results : [];
        const unfinishedShots = getUnfinishedCommerceImageSetShots(value);
        const hasCompleted = unfinishedShots.length < runnableShots.length;
        const showFill = hasCompleted && unfinishedShots.length > 0;
        const { completed: processed, total } = node.apiGenerationProgress || {};
        const progressLabel = pendingAction?.action === 'fill' ? '正在补齐图位' : '正在生成图片';
        const progress = busy && !hasIndependentTasks && Number.isInteger(processed) && Number.isInteger(total)
            && total > 0 && processed >= 0 && processed <= total ? `${progressLabel}（${processed} / ${total}）` : '';
        const missingPrompt = runnableShots.some(shot => shot.source === 'generate' && !shot.prompt?.trim());
        const currentPlan = !!plan?.sourceKey && !plan.stale && !copyLanguageChanged && plan.platformId === platformId && selectedShots.length > 0
            && plan.shots.length === selectedShots.length && plan.shots.every((shot, index) => (
                shot.id === selectedShots[index].id && shot.aspect === selectedShots[index].aspect
            ));
        const readyToGenerate = currentPlan && runnableShots.length > 0 && !referenceIssue && (!needsImageModel || image.ready) && !missingPrompt;
        const readyToFill = currentPlan && !referenceIssue && unfinishedShots.every(shot => (
            shot.source === 'reference' || image.ready && shot.prompt?.trim()
        ));
        const readyToReplan = currentPlan && !referenceIssue && planner.ready;
        const canRetry = currentPlan && !referenceIssue && image.ready;
        setOptions(fields.platformId, Object.values(COMMERCE_IMAGE_SET_PRESETS).map(item => [item.id, item.label]), platformId);
        setOptions(fields.copyLanguage, Object.entries(COMMERCE_IMAGE_SET_COPY_LANGUAGES), copyLanguage);
        for (const [group] of shotGroups) {
            const field = `${group}Aspect`;
            setOptions(fields[field], COMMERCE_IMAGE_SET_ASPECTS.map(aspect => [aspect, aspect]), value[field] || COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group]);
        }
        for (const [prefix, options] of [['planner', planner], ['image', image]]) {
            setOptions(fields[`${prefix}ModelId`], options.models.map(model => [model.id, model.name || model.modelId]), value[`${prefix}ModelId`], '选择模型');
            setOptions(fields[`${prefix}ProviderId`], options.providers.map(provider => [provider.id, provider.name || provider.id]), value[`${prefix}ProviderId`], '选择供应商');
        }
        for (const control of Object.values(fields)) control.disabled = locked;
        const product = getCommerceProductInfo(value);
        for (const control of productFields) {
            const item = product[control.dataset.commerceProductField];
            const fieldValue = Array.isArray(item) ? item.join('\n') : item;
            if (documentRef.activeElement !== control && control.value !== fieldValue) control.value = fieldValue;
            control.disabled = locked;
        }
        const filledDetails = [product.audience, product.useCases, product.details].filter(Boolean).length;
        productExtra.hidden = !filledDetails;
        if (filledDetails && productExtra.textContent !== `${filledDetails} 项已填`) productExtra.textContent = `${filledDetails} 项已填`;
        const analyzing = pendingAction?.action === 'analyze';
        const analyzeHint = productMessage || '可选填。生成方案时，AI 会根据参考图补全。';
        if (productHint.textContent !== analyzeHint) productHint.textContent = analyzeHint;
        analyzeButton.disabled = locked || !!referenceIssue || !planner.ready;
        analyzeButton.setAttribute('aria-busy', String(analyzing));
        analyzeButton.title = referenceIssue || (!planner.ready ? '请先选择支持图片输入的规划模型和供应商。' : '');
        const analysisLabel = analyzing ? '分析中…' : '分析产品';
        if (analyzeLabel.textContent !== analysisLabel) analyzeLabel.textContent = analysisLabel;
        guide.textContent = Array.isArray(preset.guide) ? preset.guide.join(' ') : (preset.guide || '');
        renderShotChoices(preset, selectedPresetShots, locked);
        exportButton.hidden = !hasCommerceImageSetExportMedia(node.data.mediaAssetKeys);
        planSection.hidden = !plan && exportButton.hidden;
        shots.hidden = !plan;
        const planTitle = plan ? '套图方案' : '上次套图';
        if (planHeading.textContent !== planTitle) {
            planHeading.textContent = planTitle;
            planSection.setAttribute('aria-label', planTitle);
        }
        planButton.textContent = plan ? '重新规划' : '生成方案';
        planButton.classList.toggle('btn-primary', !currentPlan);
        planButton.classList.toggle('btn-secondary', currentPlan);
        planButton.disabled = locked || !selectedPresetShots.length || !!referenceIssue || !planner.ready;
        generateButton.hidden = !currentPlan;
        generateButton.disabled = locked || !readyToGenerate;
        const confirmation = plan?.confirmed ? '' : '确认并';
        const generateLabel = `${confirmation}${hasCompleted ? '重做整套' : '生成套图'}`;
        if (generateButton.textContent !== generateLabel) generateButton.textContent = generateLabel;
        generateButton.classList.toggle('btn-primary', !showFill);
        generateButton.classList.toggle('btn-secondary', showFill);
        fillButton.hidden = !currentPlan || !showFill;
        fillButton.disabled = locked || !showFill || !readyToFill;
        if (showFill) {
            const label = `${confirmation}补齐 ${unfinishedShots.length} 个图位`;
            if (fillButton.textContent !== label) fillButton.textContent = label;
        }
        actionButtons.hidden = busy;
        const restoreFooterFocus = !busy && documentRef.activeElement === cancelAllButton;
        cancelAllButton.hidden = !busy || unavailable;
        cancelAllButton.setAttribute('aria-disabled', String(cancelingAll));
        progressBar.hidden = !progress;
        if (progress) {
            progressBar.max = total;
            progressBar.value = processed;
        }
        const replanHint = copyLanguageChanged ? '图中文字语言已修改，请重新规划。'
            : '商品资料或生成设置已修改，请重新规划。';
        const needsPlannerHint = !planner.ready && (!currentPlan || plan?.shots.some(shot => shot.customScene && !shot.sceneSummary));
        const needsImageHint = currentPlan && !image.ready && (needsImageModel || plan.shots.some(shot => shot.customScene && shot.sceneSummary));
        const hint = referenceIssue || (needsPlannerHint ? '请在「模型与供应商」中选择支持图片输入的规划模型。'
            : plan && !currentPlan ? replanHint
                : needsImageHint ? '请在「模型与供应商」中选择生图模型和供应商。'
                    : missingPrompt ? '请填写每张待生成图片的提示词。' : '');
        const runningLabel = node.runStatus === 'running' ? '正在执行…' : '等待执行…';
        const statusMessage = busy ? (cancelingAll ? '正在取消套图任务…' : progress || activeShotLabel || runMessage || runningLabel) : runMessage || hint;
        if (status.textContent !== statusMessage) status.textContent = statusMessage;
        if (restoreFooterFocus) {
            const target = [fillButton, generateButton, planButton].find(button => !button.hidden && !button.disabled) || status;
            target.focus({ preventScroll: true });
        }
        const completed = results.filter(result => result.status === 'completed' && !getShotPreview(result.shotId));
        const priorAssets = completed.length ? [] : (node.data.mediaAssetKeys || []).filter(assetUrl);
        const latestShot = plan?.shots.findLast(({ id }) => {
            const preview = getShotPreview(id);
            return preview?.status === 'completed' && preview.image;
        });
        if (latestShot) activeShotId = latestShot.id;
        const savedCover = completed.find(result => result.shotId === activeShotId && assetUrl(result.assetKey))
            || completed.find(result => assetUrl(result.assetKey));
        const heldCover = node.commerceShotPreviews ? cover.getAttribute('src') : '';
        const previewUrl = getShotPreview(latestShot?.id)?.image || heldCover || assetUrl(savedCover?.assetKey || priorAssets[0]);
        setImage(cover, previewUrl);
        card.dataset.hasCover = String(!!previewUrl);
        cardTitle.textContent = node.el.dataset.nodeTitle || '电商套图';
        cardProgress.textContent = progress || activeShotLabel || (priorAssets.length ? `上次套图 · ${priorAssets.length} 张`
            : plan ? `${completed.length} / ${plan.shots.length} 张` : '');
        renderShots(plan, results, { locked: shotsLocked, readyToReplan, canRetry,
            canAppendScene: currentPlan && !shotsLocked, shownShotId: latestShot?.id || savedCover?.shotId });
    }

    function setShotSelection(value, ids) {
        preserveCommerceImageSetExportResults(value);
        value.selectedShotIds = getSelectedCommerceImageSetShots({ ...value, selectedShotIds: ids }).map(shot => shot.id);
        value.plan = null;
        value.results = [];
        activeShotId = '';
        runMessage = '';
    }

    function updateShotSelection(control) {
        const value = config();
        const selected = new Set(getSelectedCommerceImageSetShots(value).map(shot => shot.id));
        const id = control.dataset.commerceSelectShot;
        if (selected.has(id) === control.checked) return;
        if (control.checked) selected.add(id);
        else selected.delete(id);
        setShotSelection(value, [...selected]);
    }

    function updateSelect(control) {
        const field = control.dataset.commerceField;
        const value = config();
        if (field === 'copyLanguage') {
            if (updateCommerceImageSetCopyLanguage(value, control.value)) {
                runMessage = '';
                setup.open = true;
            }
            return;
        }
        if (value[field] === control.value) return;
        value[field] = control.value;
        if (field === 'platformId') {
            const sceneIds = getSelectedCommerceImageSetShots(value).filter(shot => shot.customScene).map(shot => shot.id);
            setShotSelection(value, sceneIds);
            return;
        }
        if (field.endsWith('Aspect')) {
            setShotSelection(value, getSelectedCommerceImageSetShots(value).map(shot => shot.id));
            return;
        }
        if (field.endsWith('ModelId')) {
            const prefix = field.slice(0, -7);
            const options = modelOptions(prefix === 'planner' ? 'chat' : 'image', value[field], '');
            value[`${prefix}ProviderId`] = options.providers.length === 1 ? options.providers[0].id : '';
        }
        if (value.plan) {
            value.plan.confirmed = false;
            if (field !== 'imageModelId' && field !== 'imageProviderId') value.plan.sourceKey = '';
        }
        runMessage = '';
    }

    element.addEventListener('change', event => {
        if (event.target.tagName === 'SELECT') updateSelect(event.target);
        else if (event.target.hasAttribute('data-commerce-select-shot')) updateShotSelection(event.target);
    });
    element.addEventListener('input', event => {
        if (event.target.tagName === 'SELECT') {
            updateSelect(event.target);
            return;
        }
        if (event.target.hasAttribute('data-commerce-select-shot')) {
            updateShotSelection(event.target);
            return;
        }
        const value = config();
        if (event.target.dataset.commerceProductField) {
            const key = event.target.dataset.commerceProductField;
            const input = key === 'sellingPoints' ? event.target.value.split('\n') : event.target.value;
            if (!updateCommerceProductInfoField(value, key, input)) return;
            productMessage = '';
        } else if (value.plan && event.target.dataset.commerceShotField) {
            const field = event.target.dataset.commerceShotField;
            const shot = value.plan.shots.find(item => item.id === event.target.closest('[data-commerce-shot-id]')?.dataset.commerceShotId);
            if (shot?.source !== 'generate') return;
            if (field === 'description') {
                if (!shot.customScene || !updateCommerceSceneDescription(value, shot.id, event.target.value)) return;
                shotNotices.delete(shot.id);
                onChange({ commerceShotId: shot.id, commerceSceneChanged: true });
            } else {
                if (field !== 'prompt' && !(shot.allowCopy && Object.hasOwn(COMMERCE_IMAGE_SET_COPY_LIMITS, field))) return;
                shot[field] = event.target.value;
                if (shot.customScene) shot.sceneConfirmed = false;
                else value.plan.confirmed = false;
                onChange({ commerceShotId: shot.id, commerceShotField: field });
            }
        } else return;
        runMessage = '';
    });
    const isCurrentNode = () => state.nodes.get(node.id) === node;

    function restoreActionFocus(row, button) {
        if (row && documentRef.activeElement === row && !button.disabled && button.checkVisibility()) {
            button.focus({ preventScroll: true });
        }
    }

    function runError(result) {
        const nodeError = result?.nodeResults?.find(item => item.nodeId === node.id)?.error;
        return result?.error || nodeError || (result?.outcome === 'failed' ? '执行失败。'
            : result === false || result?.executed === false ? '执行未启动。' : '');
    }

    async function runAction(action) {
        pendingAction = { action };
        runMessage = action === 'analyze' ? '正在分析产品…'
            : action === 'plan' ? '正在分析产品并规划套图…'
                : action === 'fill' ? '正在补齐图位…' : '正在生成图片…';
        if (action === 'generate') {
            shotNotices.clear();
        } else if (action === 'fill') {
            for (const { id } of getUnfinishedCommerceImageSetShots(config())) shotNotices.delete(id);
        }
        if (action === 'generate' || action === 'fill') {
            config().plan.confirmed = true;
            onChange();
        }
        if (action === 'analyze' || action === 'plan') productMessage = '';
        refresh();
        try {
            const result = await run(action);
            runMessage = result?.outcome === 'stopped' ? '已取消套图任务。' : runError(result);
            if (action === 'plan' && !runMessage) {
                activeShotId = '';
                setup.open = !config().plan;
            }
            if (action === 'analyze' && !runMessage) {
                const product = getCommerceProductInfo(config());
                productMore.open ||= !!(product.audience || product.useCases || product.details);
                productMessage = '分析完成，可继续编辑产品信息。';
            }
        } catch (error) {
            runMessage = error?.message || '执行失败。';
        } finally {
            pendingAction = null;
            if (isCurrentNode()) refresh();
        }
    }

    async function runShotAction(action, shotId, shotView) {
        if (!shotView || isActiveShot(shotTaskStatus(shotId))) return;
        const planning = action === 'replan-shot';
        const shot = config().plan?.shots.find(item => item.id === shotId);
        if (!planning && shot?.customScene && !shot.sceneConfirmed) {
            if (!confirmCommerceSceneShot(config(), shotId)) return;
            onChange({ commerceShotId: shotId, commerceSceneChanged: true });
        }
        const pending = { status: planning ? 'planning' : 'running', observed: false };
        const failureNotice = text => {
            const result = config().results?.find(item => item.shotId === shotId);
            if (planning || result?.status !== 'failed') {
                const detail = !planning && result?.status === 'completed' ? `已保留上次成图。${text}` : text;
                shotNotices.set(shotId, { status: planning ? 'plan-failed' : 'retry-failed', text: detail });
            }
        };
        shotNotices.delete(shotId);
        pendingShots.set(shotId, pending);
        runMessage = '';
        refresh();
        if (documentRef.activeElement === shotView.row) shotView.cancelShot.focus({ preventScroll: true });
        try {
            const result = await run(action, shotId);
            if (pendingShots.get(shotId) !== pending) return;
            if (result?.outcome === 'stopped' || result?.outcome === 'canceled') {
                shotNotices.set(shotId, { status: 'canceled' });
            } else {
                const error = runError(result);
                if (error) failureNotice(error);
            }
        } catch (error) {
            if (pendingShots.get(shotId) === pending) failureNotice(error?.message || '执行失败。');
        } finally {
            if (pendingShots.get(shotId) === pending) {
                if (isCurrentNode()) {
                    // Keep the action identity available while the cancel button hands focus back.
                    pending.observed = true;
                    refresh();
                    restoreActionFocus(shotView.row, planning ? shotView.replan : shotView.retry);
                }
                pendingShots.delete(shotId);
            }
        }
    }

    async function cancelAction(shotId) {
        if (shotId) cancelingShots.add(shotId);
        else cancelingAll = true;
        refresh();
        try {
            if (await cancel(shotId) !== false) return;
        } catch (error) {
            runMessage = error?.message || '无法取消套图任务。';
        }
        if (shotId) cancelingShots.delete(shotId);
        else cancelingAll = false;
        if (isCurrentNode()) refresh();
    }

    async function handleAction(event) {
        const button = event.target.closest('[data-commerce-action]');
        if (!button || button.hidden || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
        const action = button.dataset.commerceAction;
        const shotRow = button.closest('[data-commerce-shot-id]');
        const shotId = shotRow?.dataset.commerceShotId;
        if (action === 'export') {
            if (closeExportDialog || documentRef.getElementById('commerce-export-dialog')) return;
            const manifest = projectCommerceImageSetExport({ settings: config(), mediaAssetKeys: node.data.mediaAssetKeys });
            try {
                closeExportDialog = openCommerceImageSetExport({
                    manifest, documentRef, opener: button, onClose: () => { closeExportDialog = null; }
                });
            } catch (error) {
                runMessage = error?.message || '无法打开导出套图。';
                refresh();
            }
            return;
        }
        if (action === 'add-scene') {
            const scene = appendCommerceSceneShot(config(), button.dataset.commerceSceneGroup);
            if (!scene) return;
            onChange({ commerceShotId: scene.id, commerceSceneChanged: true });
            refresh();
            expandShotEditor(scene.id);
            shotRows.get(scene.id)?.editor.querySelector('[data-commerce-shot-field="description"]')?.focus();
            return;
        }
        if (action === 'cancel-shot' || action === 'cancel-all') {
            await cancelAction(shotId);
            return;
        }
        if (action === 'error-detail') {
            if (button.hidden) return;
            const value = config();
            const shot = value.plan?.shots.find(item => item.id === shotId);
            const result = getShotPreview(shotId) || value.results?.find(item => item.shotId === shotId);
            if (shot && result?.status === 'failed') openShotError(shot.label, result.error || '本次生成未返回图片。');
            return;
        }
        if (action === 'preview') {
            const available = (config().plan?.shots || []).map(({ id }) => ({ id, src: shotRows.get(id)?.image.getAttribute('src') }))
                .filter(({ src }) => src);
            const index = available.findIndex(({ id }) => id === shotId);
            if (index < 0) return;
            activeShotId = shotId;
            refresh();
            await openResultPreview(available.map(({ src }) => src), index, () => {
                if (button.isConnected && !button.closest('[hidden], [inert]')) button.focus({ preventScroll: true });
            });
            return;
        }
        const actionRow = documentRef.activeElement === button ? (shotRow || (action === 'analyze' ? productHeading : null)) : null;
        actionRow?.focus({ preventScroll: true });
        if (action === 'retry' || action === 'replan-shot') {
            await runShotAction(action, shotId, shotRows.get(shotId));
            return;
        }
        if (!pendingAction) {
            const restoreFocus = documentRef.activeElement === button;
            const work = runAction(action);
            if (restoreFocus && !cancelAllButton.hidden) cancelAllButton.focus({ preventScroll: true });
            await work;
        }
        restoreActionFocus(actionRow, button);
    }
    element.addEventListener('click', handleAction);
    actions.addEventListener('click', handleAction);
    return { element, actions, refresh, destroy() { closeExportDialog?.(); clearShotRows(); } };
}
