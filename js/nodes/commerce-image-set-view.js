import { resolveVisualStyle, visualStyleKey } from '../features/visual-style/visual-style.js';
import { COMMERCE_ART_DIRECTION_LIMIT, resolveCommerceImageSetStyle, updateCommerceArtDirection } from '../features/ecommerce-image-set/commerce-art-direction.js';
import { visualStyleText } from '../features/visual-style/visual-style.js';
import {
    COMMERCE_IMAGE_SET_ASPECTS, COMMERCE_IMAGE_SET_COPY_LANGUAGES,
    COMMERCE_IMAGE_SET_DEFAULT_ASPECTS, COMMERCE_IMAGE_SET_PRESETS, COMMERCE_PRODUCT_INFO_LIMITS,
    COMMERCE_SCENE_DESCRIPTION_LIMIT, COMMERCE_CANDIDATE_GENERATION_LIMIT,
    appendCommerceSceneShot, getCommerceProductInfo, getCommerceSceneSummary, getCommerceShotCandidates, getCommerceShotCopy,
    getCommerceAmazonMainMode, getCommerceReferenceTypes, getGeneratableCommerceImageSetShots, getRunnableCommerceImageSetShots, getSelectedCommerceImageSetShots,
    getUnfinishedCommerceImageSetShots, isCommerceShotImageStale,
    normalizeCommerceImageSetCandidateCount, normalizeCommerceImageSetCopyLanguage, normalizeCommerceImageSetState,
    preserveCommerceImageSetExportResults, setCommerceShotFinalized,
    updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField, updateCommerceSceneDescription
} from '../features/ecommerce-image-set/commerce-image-set-plan.js';
import { hasCommerceImageSetExportMedia, projectCommerceImageSetExport } from '../features/ecommerce-image-set/commerce-image-set-export.js';
import { openCommerceImageSetExport } from '../features/ecommerce-image-set/commerce-image-set-export-dialog.js';
import { openCommerceDetailPage } from '../features/ecommerce-image-set/commerce-detail-page-dialog.js';
import { getCommerceOutputAssetKey } from '../features/ecommerce-image-set/commerce-detail-page.js';
import {
    COMMERCE_REFERENCE_CHANGED_MESSAGE, getCommerceReferenceRevision, hasCommerceReferenceChange, needsCommerceReferenceVerification,
    projectCommerceReferences, sameCommerceReferenceProjection, verifyCommerceReferenceContent
} from '../features/ecommerce-image-set/commerce-reference-revision.js';
import { openCommerceShotCandidates } from '../features/ecommerce-image-set/commerce-shot-candidates-dialog.js';
import { createCommerceShotReferenceControls } from '../features/ecommerce-image-set/commerce-shot-reference-controls.js';
import { hasCommerceStyleReferenceChange, projectCommerceStyleReferences } from '../features/ecommerce-image-set/commerce-shot-references.js';
import { getCommerceImageConfigurationIssue } from '../features/execution/commerce-run-preflight.js';
import { getEffectiveProtocol, getModelProviders, getModelsForTask } from '../features/execution/provider-request-utils.js';
import { getOpenAIChatCapabilities } from '../features/execution/openai-chat-capabilities.js';
import { confirmAction } from '../features/ui/app-dialogs.js';

const shotGroups = [['gallery', '主副图'], ['detail', '详情图']];
const candidateCountOptions = Array.from({ length: COMMERCE_CANDIDATE_GENERATION_LIMIT }, (_, index) => [String(index + 1), `${index + 1} 张`]);
const selectControl = (field, label = '') => `<select class="ui-select" data-commerce-field="${field}"${label ? ` aria-label="${label}"` : ''}></select>`;
const stopIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const addIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const exportIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/></svg>';
const lockIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const trashIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg>';
const isActiveShot = status => ['pending', 'running', 'planning'].includes(status);
const hasExportImages = manifest => manifest.rows.some(row => row.assetKey);
const initialExportVersion = (current, previous) => !hasExportImages(current) && hasExportImages(previous) ? 'previous' : 'current';
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
    element.toggleAttribute('hidden', !url);
}

function setAttributeIfChanged(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function createCommerceImageSetView({ node, state, documentRef, run, cancel, removeScene, onChange, openResultPreview,
    openShotError, bindReferencePrompt, readReferenceAsset, referenceImageCatalog, pickCommerceStyleReference, openModelSettings, focusReferenceSource, connectReference, showReferenceDetails, productReferences }) {
    const card = node.el.querySelector('.commerce-image-set-card');
    const cover = card.querySelector('img');
    const cardTitle = card.querySelector('.commerce-image-set-card-title');
    const cardProgress = card.querySelector('.commerce-image-set-card-progress');
    const panelId = `commerce-image-set-${++panelSequence}`;
    const editorIdPrefix = `${panelId}-shot`;
    const element = documentRef.createElement('section');
    element.className = 'commerce-image-set-settings';
    element.innerHTML = `<details class="commerce-image-set-configuration" open>
        <summary hidden>
            <span class="commerce-image-set-configuration-copy">
                <strong>套图配置</strong>
                <span data-commerce-configuration-summary></span>
            </span>
        </summary>
        <div class="commerce-image-set-configuration-body">
        <section class="commerce-image-set-goods node-parameter-section" aria-label="商品资料">
        <details class="commerce-image-set-product" open>
            <summary><strong>产品信息</strong><span class="commerce-image-set-section-summary" data-commerce-product-summary hidden></span></summary>
            <div class="commerce-image-set-product-body">
                <div class="commerce-image-set-product-header">
                    <p class="commerce-image-set-product-hint" id="${panelId}-product-hint" role="status"></p>
                    <button type="button" class="commerce-image-set-analyze" data-commerce-action="analyze" aria-describedby="${panelId}-product-hint">
                        <svg class="commerce-image-set-analyze-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M7 12h10"/><path d="M10 8h4m-4 8h4"/></svg>
                        <span class="commerce-image-set-analyze-spinner functional-animation" aria-hidden="true"></span>
                        <span class="commerce-image-set-analyze-label">分析产品</span>
                    </button>
                </div>
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
            </div>
        </details>
    </section>
    <details class="commerce-image-set-setup" open>
        <summary><strong>套图设置</strong><span class="commerce-image-set-section-summary"></span></summary>
        <div class="commerce-image-set-setup-fields">
            <div class="commerce-image-set-platform">
                <label>平台${selectControl('platformId')}</label>
                <label data-commerce-main-mode>亚马逊 MAIN${selectControl('mainImageMode')}</label>
            </div>
            <div class="commerce-image-set-selection">
                ${shotGroups.map(([group, title]) => `<section class="commerce-image-set-choice-group">
                    <div class="commerce-image-set-group-heading">
                        <h3>${title}</h3>
                        <label>比例${selectControl(`${group}Aspect`, `${title}比例`)}</label>
                    </div>
                    <div class="commerce-image-set-shot-choices" data-commerce-choice-group="${group}" role="group" aria-label="${title}图位"></div>
                </section>`).join('')}
            </div>
            <details class="commerce-image-set-disclosure commerce-image-set-output">
                <summary>输出选项</summary>
                <div class="commerce-image-set-platform">
                    <label>图中文字语言${selectControl('copyLanguage')}</label>
                    <label>每图位生成${selectControl('candidateCount')}</label>
                    <p class="commerce-image-set-guide"></p>
                </div>
            </details>
        </div>
    </details>
    <section class="commerce-image-set-style node-parameter-section" aria-label="套图风格">
        <details class="commerce-image-set-disclosure commerce-image-set-art-direction">
            <summary>整套美术风格<span class="commerce-image-set-section-summary" data-commerce-art-direction-summary></span></summary>
            <div class="commerce-image-set-art-direction-fields">
                <label for="${panelId}-art-direction">风格描述</label>
                <textarea id="${panelId}-art-direction" data-commerce-art-direction rows="3" maxlength="${COMMERCE_ART_DIRECTION_LIMIT}" placeholder="留空由 AI 在规划时确定；也可填写表现形式、配色、光影和整体氛围。"></textarea>
                <p class="commerce-image-set-product-hint" data-commerce-art-direction-status role="status"></p>
                <button type="button" class="btn btn-secondary" data-commerce-art-direction-reset>重新由 AI 设定</button>
            </div>
        </details>
    </section>
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
        </div>
    </details>
    <section class="commerce-image-set-plan" aria-label="套图方案" hidden>
        <header class="commerce-image-set-plan-heading">
            <h3 tabindex="-1">套图方案</h3>
            <button type="button" class="commerce-image-set-export-trigger" data-commerce-action="preview-previous" data-node-read-action aria-haspopup="dialog" hidden>预览上次套图</button>
            <button type="button" class="commerce-image-set-export-trigger" data-commerce-action="export" data-node-read-action aria-haspopup="dialog" hidden>${exportIcon}<span>导出套图</span></button>
        </header>
        <p class="commerce-image-set-plan-notice" role="status" hidden></p>
        <p class="commerce-image-set-plan-progress" hidden></p>
        <div class="commerce-image-set-shots">
            ${shotGroups.map(([group, title]) => `<section class="commerce-image-set-result-group" data-commerce-result-group="${group}">
                <header class="commerce-image-set-group-heading">
                    <div class="commerce-image-set-result-title"><h4>${title}</h4><span class="commerce-image-set-result-count"></span></div>
                    <div class="commerce-image-set-group-actions">
                        ${group === 'detail' ? '<button type="button" class="commerce-image-set-export-trigger" data-commerce-action="preview-detail-page" data-node-read-action aria-haspopup="dialog" hidden>连续预览</button>' : ''}
                        <button type="button" class="commerce-image-set-add-scene" data-commerce-action="add-scene" data-commerce-scene-group="${group}" aria-label="添加${title}场景图">${addIcon}<span>添加场景图</span></button>
                    </div>
                </header>
            </section>`).join('')}
        </div>
    </section>`;
    const actions = documentRef.createElement('div');
    actions.className = 'commerce-image-set-footer';
    actions.innerHTML = `<div class="commerce-image-set-run-summary">
            <p id="${panelId}-run-status" class="commerce-image-set-status" role="status" tabindex="-1"></p>
            <button type="button" class="btn btn-secondary commerce-image-set-recovery" data-commerce-action="resolve-blocker"
                aria-describedby="${panelId}-run-status" hidden></button>
            <button type="button" class="commerce-image-set-stop" data-commerce-action="cancel-all" hidden>${stopIcon}<span>取消全部</span></button>
        </div>
        <div class="commerce-image-set-run-summary" data-commerce-selection-recovery hidden>
            <p id="${panelId}-selection-help" class="commerce-image-set-selection-hint">请至少勾选一个图位。</p>
            <button type="button" class="btn btn-secondary commerce-image-set-choose-shots" data-commerce-action="choose-shots"
                aria-describedby="${panelId}-selection-help">选择图位</button>
        </div>
        <progress class="commerce-image-set-progress" aria-label="套图生成进度" hidden></progress>
        <div class="commerce-image-set-batch-scope" hidden>
            <p id="${panelId}-generate-scope" data-commerce-run-summary="generate" hidden></p>
            <p id="${panelId}-fill-scope" data-commerce-run-summary="fill" hidden></p>
        </div>
        <div class="commerce-image-set-actions">
            <button type="button" class="btn btn-primary" data-commerce-action="plan">生成方案</button>
            <button type="button" class="btn btn-primary" data-commerce-action="generate" aria-describedby="${panelId}-generate-scope" hidden>确认并生成套图</button>
            <button type="button" class="btn btn-primary" data-commerce-action="fill" aria-describedby="${panelId}-fill-scope" hidden>补齐图位</button>
        </div>`;
    const fields = Object.fromEntries(Array.from(element.querySelectorAll('[data-commerce-field]'), control => [control.dataset.commerceField, control]));
    element.querySelector('.commerce-image-set-goods').prepend(productReferences);
    const productFields = Array.from(element.querySelectorAll('[data-commerce-product-field]'));
    const productSettings = element.querySelector('.commerce-image-set-product');
    const configuration = element.querySelector('.commerce-image-set-configuration');
    const configurationToggle = configuration.querySelector('summary');
    const configurationSummary = configuration.querySelector('[data-commerce-configuration-summary]');
    const productHeading = productSettings.querySelector('summary');
    const productSummary = productHeading.querySelector('[data-commerce-product-summary]');
    const productHint = productSettings.querySelector('.commerce-image-set-product-hint');
    const productMore = element.querySelector('.commerce-image-set-product-more');
    const productExtra = productMore.querySelector('.commerce-image-set-product-extra');
    const analyzeButton = element.querySelector('[data-commerce-action="analyze"]');
    const analyzeLabel = analyzeButton.querySelector('.commerce-image-set-analyze-label');
    const setup = element.querySelector('.commerce-image-set-setup');
    const modelSettings = element.querySelector('.node-model-settings');
    const setupSummary = setup.querySelector('summary');
    const setupSelection = setupSummary.querySelector('span');
    const outputSettings = setup.querySelector('.commerce-image-set-output');
    const artDirection = element.querySelector('.commerce-image-set-art-direction');
    const artSummary = artDirection.querySelector('[data-commerce-art-direction-summary]');
    const artInput = artDirection.querySelector('[data-commerce-art-direction]');
    const artReset = artDirection.querySelector('[data-commerce-art-direction-reset]');
    const artStatus = artDirection.querySelector('[data-commerce-art-direction-status]');
    const mainImageMode = element.querySelector('[data-commerce-main-mode]');
    const guide = element.querySelector('.commerce-image-set-guide');
    const shotSelection = element.querySelector('.commerce-image-set-selection');
    const choiceGroups = new Map(shotGroups.map(([group]) => [group, shotSelection.querySelector(`[data-commerce-choice-group="${group}"]`)]));
    const planSection = element.querySelector('.commerce-image-set-plan');
    const planHeader = planSection.querySelector('.commerce-image-set-plan-heading');
    const planHeading = planSection.querySelector('h3');
    const planNotice = planSection.querySelector('.commerce-image-set-plan-notice');
    const planProgress = planSection.querySelector('.commerce-image-set-plan-progress');
    const previousPreviewButton = planSection.querySelector('[data-commerce-action="preview-previous"]');
    const exportButton = planSection.querySelector('[data-commerce-action="export"]');
    const exportButtonLabel = exportButton.querySelector('span');
    const detailPreviewButton = planSection.querySelector('[data-commerce-action="preview-detail-page"]');
    const shots = element.querySelector('.commerce-image-set-shots');
    const resultGroups = new Map(shotGroups.map(([group]) => {
        const section = shots.querySelector(`[data-commerce-result-group="${group}"]`);
        return [group, { section, header: section.firstElementChild,
            count: section.querySelector('.commerce-image-set-result-count'),
            add: section.querySelector('[data-commerce-action="add-scene"]') }];
    }));
    const planButton = actions.querySelector('[data-commerce-action="plan"]');
    const generateButton = actions.querySelector('[data-commerce-action="generate"]');
    const fillButton = actions.querySelector('[data-commerce-action="fill"]');
    const cancelAllButton = actions.querySelector('[data-commerce-action="cancel-all"]');
    const status = actions.querySelector('.commerce-image-set-status');
    const blockerRecovery = actions.querySelector('[data-commerce-action="resolve-blocker"]');
    const selectionRecovery = actions.querySelector('[data-commerce-selection-recovery]');
    const progressBar = actions.querySelector('progress');
    const actionButtons = actions.querySelector('.commerce-image-set-actions');
    const batchScope = actions.querySelector('.commerce-image-set-batch-scope');
    const generateScope = batchScope.querySelector('[data-commerce-run-summary="generate"]');
    const fillScope = batchScope.querySelector('[data-commerce-run-summary="fill"]');
    const defaultPlatformId = Object.keys(COMMERCE_IMAGE_SET_PRESETS)[0];
    const config = () => (node.data.commerceImageSet ??= { platformId: defaultPlatformId, selectedShotIds: [] });
    const designReferences = createCommerceShotReferenceControls({ documentRef, node, getSettings: config,
        pickReference: pickCommerceStyleReference, catalog: referenceImageCatalog, openPreview: openResultPreview,
        onChange: change => { onChange(change); refresh(); } });
    element.querySelector('.commerce-image-set-style').append(designReferences.element);
    const shotRows = new Map();
    const optionKeys = new WeakMap();
    const pendingShots = new Map();
    const shotNotices = new Map();
    const cancelingShots = new Set();
    let pendingAction = null;
    let cancelingAll = false;
    let runMessage = '';
    let recoverBlocker = null;
    let focusPlanReview = false;
    let productMessage = '';
    let choicePlatform = '';
    let activeShotId = '';
    let planSourceKey = null;
    let closeExportDialog = null;
    let closeCandidateDialog = null;
    let detailDialog = null;
    let legacyReferenceCheck = null;

    function matchesReferenceCheck(check, plan, projection) {
        return !!check && check.plan === plan && sameCommerceReferenceProjection(check.projection, projection);
    }

    function exportInput(settings, references, styleReferences = projectCommerceStyleReferences(state, node.id)) {
        const referenceRevision = getCommerceReferenceRevision(references);
        const plan = settings.plan;
        const needsVerification = needsCommerceReferenceVerification(settings, references);
        const { slots, groups } = references;
        if (element.isConnected && plan?.sourceKey && slots.length > 0 && slots.length <= 5 && !slots.some(slot => slot.missing)
            && !groups.some(group => group.enabled && (group.running || group.missing || !group.count)) && needsVerification
            && (!plan.stale || plan.referenceContentKey)) {
            if (!matchesReferenceCheck(legacyReferenceCheck, plan, references)) {
                const check = { plan, projection: references, status: 'checking' };
                legacyReferenceCheck = check;
                const snapshot = { ...settings, plan: { ...plan } };
                void verifyCommerceReferenceContent({ settings: snapshot, projection: references, readAsset: readReferenceAsset }).then(outcome => {
                    const current = projectCommerceReferences(state, node.id);
                    if (legacyReferenceCheck !== check || !isCurrentNode() || config().plan !== plan
                        || !matchesReferenceCheck(check, plan, current)) return;
                    if (plan.sourceKey !== snapshot.plan.sourceKey) {
                        legacyReferenceCheck = null;
                        refresh();
                        return;
                    }
                    check.status = outcome.status;
                    if (outcome.status === 'matched' && (outcome.referenceRevision || !plan.referenceContentKey)) {
                        if (outcome.referenceRevision) plan.referenceRevision = outcome.referenceRevision;
                        plan.referenceContentKey = outcome.referenceContentKey;
                        onChange();
                    }
                    refresh();
                });
            }
        }
        const legacyStatus = needsVerification && matchesReferenceCheck(legacyReferenceCheck, plan, references)
            ? legacyReferenceCheck.status : '';
        const knownChange = hasCommerceReferenceChange(settings, references);
        const unverified = needsVerification && legacyStatus !== 'matched' && legacyStatus !== 'checking';
        let styleChanged = false;
        if (plan) {
            try {
                styleChanged = visualStyleKey(plan.visualStyle) !== visualStyleKey(resolveCommerceImageSetStyle(settings, resolveVisualStyle(state, node.id)))
                    || hasCommerceStyleReferenceChange(settings, styleReferences);
            } catch { styleChanged = true; }
        }
        return { settings, mediaAssetKeys: node.data.mediaAssetKeys, referenceRevision,
            styleChanged,
            referenceChanged: knownChange || unverified,
            referenceVerificationPending: legacyStatus === 'checking',
            referenceChangeMessage: knownChange ? COMMERCE_REFERENCE_CHANGED_MESSAGE
                : '套图方案的参考图版本无法核实，请重新规划。' };
    }

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

    function renderShotChoices(preset, selectedShots, locked, finalizedIds) {
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
            const id = checkbox.dataset.commerceSelectShot;
            checkbox.checked = selected.has(id);
            checkbox.toggleAttribute('disabled', locked || finalizedIds.has(id));
            setAttributeIfChanged(checkbox.closest('label'), 'title', finalizedIds.has(id) ? '解锁后可移除此图位' : '');
        }
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
                    ${shot.customScene ? `<button type="button" class="commerce-image-set-shot-action" data-commerce-action="remove-scene" aria-haspopup="dialog">${trashIcon}</button>`
                        : `<button type="button" class="commerce-image-set-shot-action" data-commerce-action="replan-shot">重写方案</button>
                    <button type="button" class="commerce-image-set-shot-action" data-commerce-action="retry" data-node-read-action>生成图片</button>`}
                    <button type="button" class="commerce-image-set-stop" data-commerce-action="cancel-shot" hidden>${stopIcon}<span>取消</span></button>
                </div>
                <p class="commerce-image-set-version-note" role="status" hidden></p>
                ${shot.customScene ? '<p class="commerce-image-set-scene-summary" hidden></p>' : ''}
                <span class="commerce-image-set-copy-summary" hidden></span>
                <div class="commerce-image-set-shot-result-actions" hidden>
                    <button type="button" data-commerce-action="compare-shot" data-node-read-action aria-haspopup="dialog" hidden></button>
                    <button type="button" data-commerce-action="toggle-final" aria-pressed="false">${lockIcon}<span>定稿</span></button>
                </div>
                <p class="commerce-image-set-shot-notice" role="status" hidden></p>
                <div class="commerce-image-set-shot-quick-actions" hidden>
                    <button type="button" class="commerce-image-set-shot-more" data-node-read-action aria-expanded="false" hidden>更多操作</button>
                </div>
            </div>
        </div>
        <div class="commerce-image-set-shot-secondary-actions" hidden></div>
        <div class="commerce-image-set-shot-editor" hidden>
            ${shot.customScene ? `<label>场景描述（选填）<textarea data-commerce-shot-field="description" rows="2" maxlength="${COMMERCE_SCENE_DESCRIPTION_LIMIT}" placeholder="留空由 AI 推荐"></textarea></label>`
                : '<p class="commerce-image-set-shot-purpose" hidden></p>'}
            ${shot.source === 'generate' ? `<div class="commerce-image-set-copy-fields">
                <label>图上文案<textarea data-commerce-shot-field="copy" rows="5" placeholder="可粘贴多行文字，也可描述排版要求"></textarea></label>
            </div>
            <label>生图提示词<textarea data-commerce-shot-field="prompt" rows="3" maxlength="2000"></textarea></label>` : ''}
        </div>
        ${shot.customScene ? `<div class="commerce-image-set-scene-actions">
                <button type="button" class="btn" data-commerce-action="replan-shot">生成方案</button>
                <button type="button" class="btn btn-primary" data-commerce-action="retry" hidden>确认并生图</button>
        </div>` : ''}`;
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
        row.querySelector('.commerce-image-set-shot-tools').hidden = shot.source !== 'generate';
        const replan = row.querySelector('[data-commerce-action="replan-shot"]');
        replan.title = `${replan.textContent}「${shot.label}」`;
        replan.setAttribute('aria-label', replan.title);
        const retry = row.querySelector('[data-commerce-action="retry"]');
        const cancelShot = row.querySelector('[data-commerce-action="cancel-shot"]');
        const removeSceneButton = row.querySelector('[data-commerce-action="remove-scene"]');
        removeSceneButton?.setAttribute('aria-label', `删除「${shot.label}」`);
        cancelShot.setAttribute('aria-label', `取消「${shot.label}」`);
        const resultActions = row.querySelector('.commerce-image-set-shot-result-actions');
        const compareShot = resultActions.querySelector('[data-commerce-action="compare-shot"]');
        const toggleFinal = resultActions.querySelector('[data-commerce-action="toggle-final"]');
        const quickActions = row.querySelector('.commerce-image-set-shot-quick-actions');
        const more = quickActions.querySelector('.commerce-image-set-shot-more');
        const secondaryActions = row.querySelector('.commerce-image-set-shot-secondary-actions');
        secondaryActions.id = `${editor.id}-actions`;
        more.setAttribute('aria-controls', secondaryActions.id);
        more.setAttribute('aria-label', `更多操作「${shot.label}」`);
        more.addEventListener('click', () => {
            secondaryActions.hidden = !secondaryActions.hidden;
            more.setAttribute('aria-expanded', String(!secondaryActions.hidden));
        });
        const optionalActions = [replan, retry, compareShot, toggleFinal, removeSceneButton].filter(Boolean)
            .map(button => ({ button, initialParent: button.parentElement }));
        row.addEventListener('click', event => {
            if (event.target.closest('[data-commerce-action], .commerce-image-set-shot-more, .commerce-image-set-shot-secondary-actions, .commerce-image-set-shot-editor')) return;
            expandShotEditor(editor.hidden ? shot.id : null);
        });
        return { row, editor, toggle, purpose, copyFields, promptLabel: prompt?.closest('label'),
            shotFields, image, preview, replan, retry, cancelShot, removeSceneButton, failure, destroyPrompt, resultActions, compareShot, toggleFinal,
            quickActions, more, secondaryActions, optionalActions,
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

    function arrangeCompletedShotActions(row, compact, primary) {
        const focused = documentRef.activeElement;
        row.row.toggleAttribute('data-compact-result', compact);
        let hasSecondary = false;
        for (const { button, initialParent } of row.optionalActions) {
            const secondary = compact && button !== primary && !button.hidden;
            hasSecondary ||= secondary;
            const parent = button === primary ? row.quickActions : secondary ? row.secondaryActions : initialParent;
            if (button.parentElement !== parent) parent.insertBefore(button, button === primary ? row.more : null);
        }
        row.quickActions.toggleAttribute('hidden', !primary && !hasSecondary);
        row.more.toggleAttribute('hidden', !hasSecondary);
        row.secondaryActions.toggleAttribute('hidden', !hasSecondary || row.more.getAttribute('aria-expanded') !== 'true');
        if (focused !== documentRef.activeElement && row.optionalActions.some(({ button }) => button === focused)) {
            const target = focused.checkVisibility() ? focused : row.more.checkVisibility() ? row.more : row.toggle;
            target.focus({ preventScroll: true });
        }
    }

    function getShotPreview(shotId) {
        return node.commerceShotPreviews?.[shotId];
    }

    function shotVersions(shotId, result) {
        const versions = getCommerceShotCandidates(config(), shotId);
        const hasCurrent = result?.status === 'completed' && !!assetUrl(result.assetKey);
        const current = hasCurrent ? (versions.find(version =>
            version.assetKey === result.assetKey && version.planKey === result.planKey) || result) : null;
        return { current, candidates: versions.filter(version => version !== current) };
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
        const populated = [];
        const empty = [];
        for (const [group, { section, header, count, add }] of resultGroups) {
            const groupShots = planShots.filter(shot => (shot.group || 'gallery') === group);
            section.classList.toggle('is-empty', !groupShots.length);
            (groupShots.length ? populated : empty).push(section);
            const countText = groupShots.length ? `${groupShots.length} 个图位` : '';
            if (count.textContent !== countText) count.textContent = countText;
            const addLabel = add.querySelector('span');
            const addText = groupShots.length ? '添加场景图' : add.getAttribute('aria-label');
            if (addLabel.textContent !== addText) addLabel.textContent = addText;
            add.toggleAttribute('disabled', !canAppendScene);
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
        [...populated, ...empty].forEach((section, index) => {
            const current = shots.children[index];
            if (current === section) return;
            const focused = documentRef.activeElement;
            shots.insertBefore(section, current);
            if (section.contains(focused)) focused.focus({ preventScroll: true });
        });
    }

    function renderShots(plan, results, { locked, resultsLocked, readyToReplan, canRetry, shotImageIssues, canAppendScene, shownShotId,
        referenceChanged, referenceVerificationPending, planNeedsReplan, exportRows }) {
        const planShots = plan?.shots || [];
        syncShotRows(planShots, canAppendScene);
        const savedResults = new Map(results.map(result => [result.shotId, result]));
        const exportStatuses = new Map(exportRows.map(row => [row.shotId, row.status]));
        for (const shot of planShots) {
            const row = shotRows.get(shot.id);
            const savedResult = savedResults.get(shot.id);
            const finalized = savedResult?.finalized === true;
            const liveResult = getShotPreview(shot.id);
            const result = liveResult || savedResult;
            const task = shotTaskStatus(shot.id);
            const active = isActiveShot(task);
            if (!active) cancelingShots.delete(shot.id);
            else shotNotices.delete(shot.id);
            const canceling = active && (cancelingAll || cancelingShots.has(shot.id));
            const notice = shotNotices.get(shot.id);
            const restoreFocus = !active && documentRef.activeElement === row.cancelShot;
            const sceneSummary = shot.customScene ? getCommerceSceneSummary(shot) : '';
            const scenePlanned = !!(shot.sceneSummary || shot.prompt);
            if (row.purpose) {
                if (row.purpose.textContent !== (shot.purpose || '')) row.purpose.textContent = shot.purpose || '';
                row.purpose.toggleAttribute('hidden', !shot.purpose);
            }
            if (row.sceneSummary) {
                if (row.sceneSummary.textContent !== sceneSummary) row.sceneSummary.textContent = sceneSummary;
                row.sceneSummary.toggleAttribute('hidden', !sceneSummary);
                row.promptLabel.toggleAttribute('hidden', !scenePlanned);
            }
            row.copyFields?.toggleAttribute('hidden', !shot.allowCopy || (!!shot.customScene && !scenePlanned));
            for (const field of row.shotFields) {
                const name = field.dataset.commerceShotField;
                const value = name === 'copy' ? getCommerceShotCopy(shot) : shot[name] || '';
                if (documentRef.activeElement !== field && field.value !== value) field.value = value;
                field.toggleAttribute('disabled', locked || active || finalized);
            }
            const copy = shot.allowCopy ? getCommerceShotCopy(shot).split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(' · ') : '';
            if (row.copySummary.textContent !== copy) row.copySummary.textContent = copy;
            row.copySummary.toggleAttribute('hidden', !copy || shot.customScene === true);
            const previewResult = liveResult?.image ? liveResult : savedResult;
            const previewUrl = previewResult?.image || assetUrl(getCommerceOutputAssetKey(previewResult));
            const previousImage = Boolean(previewUrl) && (referenceChanged || planNeedsReplan
                || (!liveResult?.image && exportStatuses.get(shot.id) === 'previous') || isCommerceShotImageStale(shot, previewResult));
            setImage(row.image, previewUrl);
            row.preview.toggleAttribute('hidden', !previewUrl);
            setAttributeIfChanged(row.preview, 'aria-pressed', String(shownShotId === shot.id));
            const { current, candidates } = shotVersions(shot.id, savedResult);
            const alternatives = candidates.length;
            row.resultActions.toggleAttribute('hidden', active || (!current && !alternatives));
            row.compareShot.toggleAttribute('hidden', !alternatives && !(current && shot.source === 'generate'));
            row.compareShot.toggleAttribute('disabled', resultsLocked || referenceChanged);
            const compareLabel = alternatives ? `对比 ${alternatives} 张候选` : (finalized ? '查看版本…' : '生成候选…');
            if (row.compareShot.textContent !== compareLabel) {
                row.compareShot.textContent = compareLabel;
                row.compareShot.setAttribute('aria-label', `${compareLabel}「${shot.label}」`);
            }
            row.toggleFinal.toggleAttribute('hidden', !current);
            row.toggleFinal.toggleAttribute('disabled', resultsLocked || referenceChanged || (!finalized && (previousImage || referenceVerificationPending)));
            setAttributeIfChanged(row.toggleFinal, 'aria-pressed', String(finalized));
            const finalLabel = finalized ? '解锁' : '定稿';
            const finalText = row.toggleFinal.querySelector('span');
            if (finalText.textContent !== finalLabel) finalText.textContent = finalLabel;
            setAttributeIfChanged(row.toggleFinal, 'aria-label', `${finalLabel}「${shot.label}」`);
            const finalHint = finalized ? '解锁后允许重新生成此图位。'
                : previousImage ? '请先更新成图，再定稿。' : '定稿后，批量重做会保留这张图。';
            setAttributeIfChanged(row.toggleFinal, 'title', finalHint);
            setAttributeIfChanged(row.toggleFinal, 'aria-description', finalHint);
            const failed = result?.status === 'failed' || !!result?.replacementError;
            const sceneStatus = shot.customScene && !shot.sceneConfirmed
                ? (scenePlanned ? (shot.sceneNeedsReview ? 'review-update' : 'review') : 'unplanned') : null;
            const resultStatus = canceling ? 'canceling' : task === 'pending' ? 'queued'
                : active || task === 'canceled' ? task : finalized ? 'finalized'
                    : notice?.status || (failed ? 'failed' : sceneStatus || result?.status || 'pending');
            let message = {
                planning: '正在规划', running: '正在生成', queued: '等待生成', canceling: '正在取消',
                canceled: '已取消', failed: '生成失败', completed: '已完成', 'plan-failed': '方案生成失败',
                'retry-failed': '生图未完成', unplanned: '待规划', review: '待确认', 'review-update': '待重新确认', finalized: '已定稿'
            }[resultStatus] || (shot.source === 'reference' ? '待应用' : '待生成');
            const candidateProgress = resultStatus === 'running' ? liveResult?.candidateProgress
                : resultStatus === 'completed' ? savedResult?.candidateProgress : null;
            const showingPrevious = previousImage && (resultStatus === 'completed' || resultStatus === 'finalized');
            if (showingPrevious) {
                message = resultStatus === 'finalized' ? '已定稿 · 显示上一版' : '待更新 · 显示上一版';
            } else if (candidateProgress?.total > 1) {
                const format = `${candidateProgress.completed}/${candidateProgress.total} 张`;
                message = resultStatus === 'running' ? `正在生成 ${format}` : `已生成 ${format}`;
            }
            if (row.message.textContent !== message) row.message.textContent = message;
            row.message.toggleAttribute('data-previous-image', showingPrevious);
            const versionNote = previousImage ? (referenceChanged ? '商品参考图已更换，请复核。'
                : showingPrevious ? '' : '方案已更新 · 当前为上一版') : '';
            row.versionNote.toggleAttribute('hidden', !versionNote);
            if (row.versionNote.textContent !== versionNote) row.versionNote.textContent = versionNote;
            const previewDescription = [showingPrevious ? row.message.id : '', versionNote ? row.versionNote.id : ''].filter(Boolean).join(' ');
            if (previewDescription) setAttributeIfChanged(row.preview, 'aria-describedby', previewDescription);
            else row.preview.removeAttribute('aria-describedby');
            setAttributeIfChanged(row.row, 'data-result-status', resultStatus);
            row.message.toggleAttribute('hidden', resultStatus === 'failed');
            row.failure.toggleAttribute('hidden', resultStatus !== 'failed');
            row.replan.toggleAttribute('disabled', locked || active || finalized || !readyToReplan);
            row.generationIssue = !canRetry ? '请检查参考图和套图方案后再生图。'
                : shotImageIssues.get(shot.id) || (!shot.prompt?.trim() ? '请填写该图位的生图提示词。' : '');
            row.retry.toggleAttribute('disabled', locked || active || finalized || Boolean(row.generationIssue));
            row.tools.toggleAttribute('hidden', !active && shot.source !== 'generate');
            if (row.removeSceneButton) {
                row.removeSceneButton.toggleAttribute('disabled', resultsLocked || finalized);
                setAttributeIfChanged(row.removeSceneButton, 'title', finalized ? '解锁后可删除此场景图' : `删除「${shot.label}」`);
            }
            row.replan.toggleAttribute('hidden', !shot.customScene && (active || shot.source !== 'generate'));
            row.retry.toggleAttribute('hidden', shot.customScene ? !scenePlanned : active || shot.source !== 'generate');
            setAttributeIfChanged(row.cancelShot, 'aria-disabled', String(canceling));
            row.cancelShot.toggleAttribute('hidden', !active);
            const noticeText = active ? '' : notice?.text || (!finalized && result?.replacementError ? '已保留当前成图。' : '');
            if (row.notice.textContent !== noticeText) row.notice.textContent = noticeText;
            row.notice.toggleAttribute('hidden', !noticeText);
            let generateText = savedResult?.status === 'completed' ? '重新生图' : (failed ? '重试生图' : '生成图片');
            if (shot.customScene) {
                const replanText = scenePlanned ? '重新规划' : '生成方案';
                generateText = shot.sceneConfirmed ? (savedResult?.assetKey ? '重新生成图片' : '生成图片') : '确认并生图';
                if (row.replan.textContent !== replanText) row.replan.textContent = replanText;
                const replanLabel = `${replanText}「${shot.label}」`;
                if (row.replan.title !== replanLabel) {
                    row.replan.title = replanLabel;
                    row.replan.setAttribute('aria-label', replanLabel);
                }
                row.replan.classList.toggle('btn-primary', !scenePlanned);
                row.replan.classList.toggle('btn-secondary', scenePlanned);
            }
            if (row.retry.textContent !== generateText) row.retry.textContent = generateText;
            const label = `${generateText}「${shot.label}」`;
            const retryTitle = row.generationIssue || label;
            if (row.retry.title !== retryTitle) row.retry.title = retryTitle;
            if (row.retry.getAttribute('aria-label') !== label) row.retry.setAttribute('aria-label', label);
            const compact = Boolean(previewUrl) && (resultStatus === 'completed' || resultStatus === 'finalized');
            const preferred = previousImage ? row.retry : alternatives ? row.compareShot : finalized ? null : row.toggleFinal;
            const primary = compact && preferred && !preferred.hidden && !preferred.disabled ? preferred : null;
            arrangeCompletedShotActions(row, compact, primary);
            if (restoreFocus) {
                const pending = pendingShots.get(shot.id);
                const action = pending?.status === 'planning' ? row.replan : row.retry;
                let target = row.toggle;
                if (action.checkVisibility() && !action.disabled) target = action;
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
        const candidateCount = normalizeCommerceImageSetCandidateCount(value.candidateCount);
        const selectedShots = getSelectedCommerceImageSetShots(value);
        const selectedPresetShots = selectedShots.filter(shot => !shot.customScene);
        const runnableShots = getRunnableCommerceImageSetShots(value);
        const generatableShots = getGeneratableCommerceImageSetShots(value);
        const planner = modelOptions('chat', value.plannerModelId, value.plannerProviderId);
        const image = modelOptions('image', value.imageModelId, value.imageProviderId);
        const references = projectCommerceReferences(state, node.id);
        const styleReferences = projectCommerceStyleReferences(state, node.id);
        const exportOptions = exportInput(value, references, styleReferences);
        const { referenceChanged, referenceVerificationPending, referenceChangeMessage, styleChanged } = exportOptions;
        const runningReference = references.groups.find(group => group.running);
        const missingReference = references.groups.find(group => group.enabled && (!group.count || group.missing || group.missingPositions.length))
            || references.groups.find(group => !group.enabled);
        const referenceIssue = references.count > 5 ? '套图最多使用 5 张参考图，请调整输入。'
            : runningReference ? '请等待参考图来源运行完成。'
                : !references.groups.length ? '请连接 1 至 5 张可读取的商品参考图。'
                    : !references.count || references.slots.some(slot => slot.missing) ? (
                        missingReference?.source && !missingReference.enabled ? '商品参考图来源已停用，请检查上游节点。'
                            : missingReference?.enabled && !missingReference.count && !missingReference.missing ? '已连接参考图来源，请先运行上游或导入图片。'
                                : '商品参考图无法读取，请检查来源。'
                    ) : referenceVerificationPending ? '正在核对商品参考图…' : '';
        const plan = value.plan;
        const activeShots = plan?.shots.filter(shot => isActiveShot(shotTaskStatus(shot.id))) || [];
        const activeShotLabel = activeShots.length ? `${activeShots.length} 个图位进行中` : '';
        const hasIndependentTasks = activeShots.some(({ id }) => isActiveShot(node.commerceShotTasks?.[id])
            || pendingShots.get(id)?.observed === false);
        const busy = !!(pendingAction || activeShots.length || state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus));
        const savingResults = busy && !activeShots.length && Object.keys(node.commerceShotPreviews || {}).length > 0;
        if (!busy) cancelingAll = false;
        const unavailable = node.enabled === false || node.isClone === true;
        const locked = busy || unavailable;
        designReferences.update(getCommerceReferenceTypes(value), { styleReferences, locked,
            activeShotIds: activeShots.map(shot => shot.id),
            finalizedShotIds: (value.results || []).filter(row => row.finalized).map(row => row.shotId) });
        let connectedStyle = null;
        try { connectedStyle = resolveVisualStyle(state, node.id); } catch { /* The normal style issue reports an unavailable source. */ }
        const artText = connectedStyle ? visualStyleText(connectedStyle) : value.artDirection || plan?.artDirection || '';
        if ((documentRef.activeElement !== artInput || !value.artDirection) && artInput.value !== artText) artInput.value = artText;
        artInput.toggleAttribute('disabled', locked || !!connectedStyle);
        artReset.toggleAttribute('disabled', locked);
        artReset.toggleAttribute('hidden', !!connectedStyle || !artText);
        const artStatusText = connectedStyle ? '沿用已连接的画面风格。'
            : value.artDirection ? '使用自定风格；各图位按用途变化构图。'
                : plan?.artDirection ? 'AI 已确定本套风格，可直接修改。' : '规划时先确定统一风格，再分别设计各图位。';
        if (artStatus.textContent !== artStatusText) artStatus.textContent = artStatusText;
        const artLabel = connectedStyle ? '沿用画面风格'
            : value.artDirection ? '自定' : plan?.artDirection ? 'AI 已设定' : '由 AI 设定';
        if (artSummary.textContent !== artLabel) artSummary.textContent = artLabel;
        const shotsLocked = unavailable || cancelingAll || (busy && !activeShots.length && !node.commerceShotPreviews)
            || ['analyze', 'plan'].includes(pendingAction?.action);
        const copyLanguageChanged = !!plan && (plan.copyLanguage ?? 'auto') !== copyLanguage;
        configurationToggle.hidden = !plan?.sourceKey;
        if (configurationToggle.hidden) configuration.open = true;
        if ((plan?.sourceKey ?? null) !== planSourceKey) {
            planSourceKey = plan?.sourceKey ?? null;
            activeShotId = '';
            shotNotices.clear();
            setup.open = !plan?.sourceKey || copyLanguageChanged;
            if (copyLanguageChanged) {
                configuration.open = true;
                outputSettings.open = true;
            } else if (plan?.sourceKey && !configuration.contains(documentRef.activeElement)) {
                configuration.open = false;
            }
            if (plan?.sourceKey) {
                for (const disclosure of [productSettings, artDirection]) {
                    if (!disclosure.contains(documentRef.activeElement)) disclosure.open = false;
                }
            }
        }
        const multipleCandidates = candidateCount > 1 && selectedShots.some(shot => shot.source === 'generate');
        const selectionLabel = `${preset.label} · ${selectedShots.length} 个图位${multipleCandidates ? ` · 每图位 ${candidateCount} 张` : ''}`;
        if (setupSelection.textContent !== selectionLabel) setupSelection.textContent = selectionLabel;
        const results = Array.isArray(value.results) ? value.results : [];
        const finalizedIds = new Set(results.filter(result => result.finalized).map(result => result.shotId));
        const unfinishedShots = getUnfinishedCommerceImageSetShots(value);
        const hasCompleted = unfinishedShots.length < runnableShots.length;
        const showFill = hasCompleted && unfinishedShots.length > 0;
        const { completed: processed, total } = node.apiGenerationProgress || {};
        const progressLabel = pendingAction?.action === 'fill' ? '正在补齐' : '正在生成';
        const showProgress = busy && !hasIndependentTasks && Number.isInteger(processed) && Number.isInteger(total)
            && total > 0 && processed >= 0 && processed <= total;
        let progress = '';
        if (showProgress) {
            const previews = Object.values(node.commerceShotPreviews || {});
            const failedCount = previews.filter(row => row.status === 'failed').length;
            const runningCount = previews.filter(row => row.status === 'running').length;
            const canceledCount = previews.filter(row => row.status === 'canceled').length;
            progress = [progressLabel, `已完成 ${processed}/${total} 个图位`,
                failedCount ? `${failedCount} 个失败` : '', runningCount ? `${runningCount} 个运行中` : '',
                canceledCount ? `${canceledCount} 个已取消` : ''].filter(Boolean).join(' · ');
        }
        const missingPrompt = generatableShots.some(shot => shot.source === 'generate' && !shot.prompt?.trim());
        const currentPlan = !!plan?.sourceKey && !styleChanged && !plan.stale && !copyLanguageChanged && !referenceChanged && !referenceVerificationPending
            && plan.platformId === platformId && selectedShots.length > 0
            && plan.shots.length === selectedShots.length && plan.shots.every((shot, index) => (
                shot.id === selectedShots[index].id && shot.aspect === selectedShots[index].aspect
            ));
        const planNeedsReplan = Boolean(plan && !currentPlan && !referenceVerificationPending);
        const planNoticeText = !planNeedsReplan ? '' : referenceChanged ? referenceChangeMessage
            : styleChanged ? '画面风格已更新，需重新规划。'
                : copyLanguageChanged ? '图中文字语言已修改，需重新规划。' : '商品资料或套图设置已修改，需重新规划。';
        if (planNotice.textContent !== planNoticeText) planNotice.textContent = planNoticeText;
        planNotice.hidden = !planNoticeText;
        const imageIssueFor = shots => currentPlan && !referenceIssue ? getCommerceImageConfigurationIssue({
            state, node, settings: value, generatedShots: shots.filter(shot => shot.source === 'generate'), referenceCount: references.count
        }) : '';
        const generateImageIssue = imageIssueFor(generatableShots);
        const fillImageIssue = imageIssueFor(unfinishedShots);
        const shotImageIssues = new Map((plan?.shots || [])
            .filter(shot => shot.source === 'generate' && !finalizedIds.has(shot.id) && (!shot.customScene || getCommerceSceneSummary(shot)))
            .map(shot => [shot.id, imageIssueFor([shot])]));
        const readyToGenerate = currentPlan && generatableShots.length > 0 && !referenceIssue && !generateImageIssue && !missingPrompt;
        const readyToFill = currentPlan && !referenceIssue && !fillImageIssue && unfinishedShots.every(shot => (
            shot.source === 'reference' || shot.prompt?.trim()
        ));
        const readyToReplan = currentPlan && !referenceIssue && planner.ready;
        const canRetry = currentPlan && !referenceIssue;
        setOptions(fields.platformId, Object.values(COMMERCE_IMAGE_SET_PRESETS).map(item => [item.id, item.label]), platformId);
        setOptions(fields.mainImageMode, [['generate', '生成白底图'], ['original', '沿用原图']], getCommerceAmazonMainMode(value));
        mainImageMode.toggleAttribute('hidden', platformId !== 'amazon');
        setOptions(fields.copyLanguage, Object.entries(COMMERCE_IMAGE_SET_COPY_LANGUAGES), copyLanguage);
        setOptions(fields.candidateCount, candidateCountOptions, String(candidateCount));
        setAttributeIfChanged(fields.candidateCount, 'title', '仅生图图位生效，每张候选调用一次生图模型');
        for (const [group] of shotGroups) {
            const field = `${group}Aspect`;
            setOptions(fields[field], COMMERCE_IMAGE_SET_ASPECTS.map(aspect => [aspect, aspect]), value[field] || COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group]);
        }
        for (const [prefix, options] of [['planner', planner], ['image', image]]) {
            setOptions(fields[`${prefix}ModelId`], options.models.map(model => [model.id, model.name || model.modelId]), value[`${prefix}ModelId`], '选择模型');
            setOptions(fields[`${prefix}ProviderId`], options.providers.map(provider => [provider.id, provider.name || provider.id]), value[`${prefix}ProviderId`], '选择供应商');
        }
        const lockedFields = new Set();
        if (finalizedIds.size) lockedFields.add('platformId');
        if (finalizedIds.has('main')) lockedFields.add('mainImageMode');
        setAttributeIfChanged(fields.platformId, 'title', finalizedIds.size ? '解锁定稿图位后可切换平台' : '');
        for (const [group] of shotGroups) {
            const field = `${group}Aspect`;
            const hasFinalized = selectedShots.some(shot => shot.group === group && shot.source === 'generate' && finalizedIds.has(shot.id));
            if (hasFinalized) lockedFields.add(field);
            setAttributeIfChanged(fields[field], 'title', hasFinalized ? '解锁本组定稿图位后可调整比例' : '');
        }
        for (const [field, control] of Object.entries(fields)) control.toggleAttribute('disabled', locked || lockedFields.has(field));
        const product = getCommerceProductInfo(value);
        const configurationLabel = [product.name, selectionLabel].filter(Boolean).join(' · ');
        if (configurationSummary.textContent !== configurationLabel) configurationSummary.textContent = configurationLabel;
        const productLabel = product.name || (product.sellingPoints.length ? `${product.sellingPoints.length} 条卖点` : '');
        productSummary.hidden = !productLabel;
        if (productSummary.textContent !== productLabel) productSummary.textContent = productLabel;
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
        const analyzeHint = productMessage || '可选填，AI 会在规划时补全。';
        if (productHint.textContent !== analyzeHint) productHint.textContent = analyzeHint;
        analyzeButton.disabled = locked || !!referenceIssue || !planner.ready;
        analyzeButton.setAttribute('aria-busy', String(analyzing));
        analyzeButton.title = referenceIssue || (!planner.ready ? '请先选择支持图片输入的规划模型和供应商。' : '');
        const analysisLabel = analyzing ? '分析中…' : '分析产品';
        if (analyzeLabel.textContent !== analysisLabel) analyzeLabel.textContent = analysisLabel;
        const guideText = Array.isArray(preset.guide) ? preset.guide.join(' ') : (preset.guide || '');
        if (guide.textContent !== guideText) guide.textContent = guideText;
        renderShotChoices(preset, selectedPresetShots, locked, finalizedIds);
        const currentManifest = projectCommerceImageSetExport(exportOptions);
        const previousManifest = projectCommerceImageSetExport({ ...exportOptions, version: 'previous' });
        previousPreviewButton.hidden = !hasExportImages(previousManifest);
        detailPreviewButton.hidden = !plan?.shots.some(shot => shot.group === 'detail');
        exportButton.hidden = previousPreviewButton.hidden && !hasExportImages(currentManifest) && !hasCommerceImageSetExportMedia(node.data.mediaAssetKeys);
        exportButton.disabled = referenceVerificationPending;
        const currentExportCount = currentManifest.rows.filter(row => row.status === 'current').length;
        const hasPreviousExportRows = currentManifest.rows.some(row => row.status === 'previous');
        const canExportFullSet = currentExportCount > 0 && currentExportCount === currentManifest.rows.length;
        const exportPrimary = currentPlan && !locked && !referenceIssue && !exportButton.hidden && !unfinishedShots.length && canExportFullSet;
        let exportLabel = '导出套图';
        if (initialExportVersion(currentManifest, previousManifest) === 'previous') exportLabel = '导出上次套图';
        else if (hasPreviousExportRows) exportLabel = currentExportCount ? '导出可用图片' : '导出上一版图片';
        else if (currentExportCount && !canExportFullSet) exportLabel = '导出已完成图片';
        if (exportButtonLabel.textContent !== exportLabel) exportButtonLabel.textContent = exportLabel;
        const exportParent = exportPrimary ? actionButtons : planHeader;
        if (exportButton.parentElement !== exportParent) {
            const restoreExportFocus = documentRef.activeElement === exportButton;
            exportParent.append(exportButton);
            if (restoreExportFocus) exportButton.focus({ preventScroll: true });
        }
        exportButton.classList.toggle('btn', exportPrimary);
        exportButton.classList.toggle('btn-primary', exportPrimary);
        planSection.hidden = !plan && exportButton.hidden;
        shots.hidden = !plan;
        const planTitle = plan ? '套图方案' : '上次套图';
        if (planHeading.textContent !== planTitle) {
            planHeading.textContent = planTitle;
            planSection.setAttribute('aria-label', planTitle);
        }
        const needsConfirmation = selectedShots.length - runnableShots.length;
        const waiting = currentExportCount === 0 ? '待生成' : '待补齐';
        const planProgressText = currentPlan && !busy ? [
            `已完成 ${currentExportCount}/${selectedShots.length} 个图位`,
            unfinishedShots.length ? `${unfinishedShots.length} 个${waiting}` : '',
            needsConfirmation ? `${needsConfirmation} 个待确认` : ''
        ].filter(Boolean).join(' · ') : '';
        if (planProgress.textContent !== planProgressText) planProgress.textContent = planProgressText;
        planProgress.hidden = !planProgressText;
        const planLabel = plan ? '重新规划' : '生成方案';
        if (planButton.textContent !== planLabel) planButton.textContent = planLabel;
        planButton.classList.toggle('btn-primary', !currentPlan);
        planButton.classList.toggle('btn-secondary', currentPlan);
        planButton.disabled = locked || !selectedPresetShots.length || !!referenceIssue || !planner.ready;
        generateButton.hidden = !currentPlan;
        generateButton.disabled = locked || !readyToGenerate;
        let generateTitle = finalizedIds.size && !generatableShots.length ? '解锁图位后可重新生成' : '';
        const confirmation = plan?.confirmed ? '' : '确认并';
        const excludedCount = (plan?.shots.length ?? 0) - runnableShots.length;
        const generateLabel = hasCompleted ? (confirmation ? '确认方案并重做' : '重做已确认图位')
            : confirmation + (excludedCount ? '生成已确认图位' : '生成套图');
        if (generateButton.textContent !== generateLabel) generateButton.textContent = generateLabel;
        generateButton.classList.toggle('btn-primary', !showFill && !exportPrimary);
        generateButton.classList.toggle('btn-secondary', showFill || exportPrimary);
        fillButton.hidden = !currentPlan || !showFill;
        fillButton.disabled = locked || !showFill || !readyToFill;
        if (showFill) {
            const label = `${confirmation}补齐 ${unfinishedShots.length} 个图位`;
            if (fillButton.textContent !== label) fillButton.textContent = label;
        }
        actionButtons.hidden = busy;
        actionButtons.toggleAttribute('data-has-secondary', currentPlan);
        const finalizedCount = runnableShots.length - generatableShots.length;
        for (const [button, scope, actionShots, label] of [
            [generateButton, generateScope, generatableShots, hasCompleted && confirmation ? '重做已确认图位' : showFill || exportPrimary ? '重做' : ''],
            [fillButton, fillScope, unfinishedShots, '补齐']
        ]) {
            scope.hidden = busy || button.hidden || button.disabled;
            const imageShotCount = actionShots.filter(shot => shot.source === 'generate').length;
            const referenceShotCount = actionShots.length - imageShotCount;
            const summary = scope.hidden ? '' : [
                label,
                `预计调用生图模型 ${imageShotCount * candidateCount} 次`,
                referenceShotCount ? `沿用原图 ${referenceShotCount} 张` : '',
                finalizedCount ? `保留定稿 ${finalizedCount} 张` : '',
                excludedCount ? `暂不执行 ${excludedCount} 个图位` : ''
            ].filter(Boolean).join(' · ');
            if (scope.textContent !== summary) scope.textContent = summary;
            const secondary = button.classList.contains('btn-secondary') && !!summary;
            scope.toggleAttribute('data-secondary', secondary);
            if (button === generateButton) {
                if (secondary) {
                    setAttributeIfChanged(button, 'data-commerce-call-count', `${imageShotCount * candidateCount} 次生图调用`);
                    generateTitle = summary;
                } else {
                    delete button.dataset.commerceCallCount;
                }
            }
        }
        setAttributeIfChanged(generateButton, 'title', generateTitle);
        batchScope.hidden = fillScope.hidden && (generateScope.hidden || generateScope.hasAttribute('data-secondary'));
        const restoreFooterFocus = !busy && documentRef.activeElement === cancelAllButton;
        cancelAllButton.hidden = !busy || unavailable;
        setAttributeIfChanged(cancelAllButton, 'aria-disabled', String(cancelingAll || savingResults));
        progressBar.hidden = !progress;
        if (progress) {
            setAttributeIfChanged(progressBar, 'max', String(total));
            setAttributeIfChanged(progressBar, 'value', String(processed));
        }
        const replanHint = styleChanged ? '画面风格已更新，请重新规划；已有成图与定稿保留。' : referenceChanged ? referenceChangeMessage
            : copyLanguageChanged ? '图中文字语言已修改，请重新规划。'
            : '商品资料或套图设置已修改，请重新规划。';
        const needsPlannerHint = !planner.ready && (!currentPlan || plan?.shots.some(shot => shot.customScene && !getCommerceSceneSummary(shot)));
        const imageIssue = generateImageIssue || fillImageIssue || [...shotImageIssues.values()].find(Boolean);
        const modelStage = imageIssue ? 'image' : needsPlannerHint ? 'planner' : '';
        let recoveryLabel = '';
        recoverBlocker = null;
        if (!locked && referenceIssue && !referenceVerificationPending) {
            const source = (runningReference || missingReference)?.source;
            if (!references.groups.length) {
                recoveryLabel = '连接参考图';
                recoverBlocker = connectReference;
            } else if (source && references.count <= 5) {
                recoveryLabel = '定位参考图来源';
                recoverBlocker = () => focusReferenceSource(source.id);
            } else {
                recoveryLabel = '查看连接明细';
                recoverBlocker = showReferenceDetails;
            }
        } else if (!locked && !referenceIssue && modelStage) {
            const model = modelStage === 'planner' ? planner : image;
            const stageName = modelStage === 'planner' ? '规划' : '生图';
            if (!model.models.length) {
                recoveryLabel = `配置${stageName}模型`;
                recoverBlocker = () => openModelSettings({ taskType: modelStage === 'planner' ? 'chat' : 'image', onClose: () => {
                    refresh();
                    if (blockerRecovery.checkVisibility()) blockerRecovery.focus({ preventScroll: true });
                } });
            } else {
                recoveryLabel = `选择${stageName}模型`;
                recoverBlocker = () => {
                    configuration.open = true;
                    modelSettings.open = true;
                    const selectedModel = fields[`${modelStage}ModelId`];
                    const provider = fields[`${modelStage}ProviderId`];
                    const target = selectedModel.value && !model.ready && model.providers.length ? provider : selectedModel;
                    target.focus({ preventScroll: true });
                    target.scrollIntoView({ block: 'nearest' });
                };
            }
        }
        blockerRecovery.hidden = !recoverBlocker;
        if (blockerRecovery.textContent !== recoveryLabel) blockerRecovery.textContent = recoveryLabel;
        const finalizedHint = currentPlan && finalizedIds.size && !generatableShots.length
            ? '可生成的图位已定稿，解锁后可重新生成。' : '';
        selectionRecovery.hidden = locked || Boolean(referenceIssue) || selectedPresetShots.length > 0;
        const plannerHint = needsPlannerHint && (planner.models.length ? '请在「模型与供应商」中选择支持图片输入的规划模型。'
            : '尚未配置支持图片输入的规划模型。');
        const hint = referenceIssue || (referenceChanged ? replanHint
            : imageIssue || plannerHint || (plan && !currentPlan ? replanHint
                : missingPrompt ? '请填写每张待生成图片的提示词。' : finalizedHint));
        const runningLabel = node.runStatus === 'running' ? '正在执行…' : '等待执行…';
        const statusMessage = busy ? (cancelingAll ? '正在取消套图任务…' : savingResults ? '正在保存成图…'
            : progress || activeShotLabel || runMessage || runningLabel) : (referenceChanged ? hint : runMessage || hint);
        if (status.textContent !== statusMessage) status.textContent = statusMessage;
        const completed = results.filter(result => result.status === 'completed' && !getShotPreview(result.shotId));
        const historyAssets = previousManifest.rows.map(row => row.assetKey).filter(assetUrl);
        const priorAssets = referenceChanged ? historyAssets : completed.length ? [] : (node.data.mediaAssetKeys || []).filter(assetUrl);
        const latestShot = plan?.shots.findLast(({ id }) => {
            const preview = getShotPreview(id);
            return preview?.status === 'completed' && preview.image;
        });
        if (latestShot) activeShotId = latestShot.id;
        const savedCover = completed.find(result => result.shotId === activeShotId && assetUrl(result.assetKey))
            || completed.find(result => assetUrl(result.assetKey));
        const heldCover = node.commerceShotPreviews ? cover.getAttribute('src') : '';
        const previewUrl = getShotPreview(latestShot?.id)?.image || heldCover || assetUrl(getCommerceOutputAssetKey(savedCover) || priorAssets[0]);
        setImage(cover, previewUrl);
        setAttributeIfChanged(card, 'data-has-cover', String(!!previewUrl));
        const title = node.el.dataset.nodeTitle || '电商套图';
        if (cardTitle.textContent !== title) cardTitle.textContent = title;
        const cardProgressText = progress || activeShotLabel || (priorAssets.length ? `上次套图 · ${priorAssets.length} 张`
            : plan ? `${completed.length} / ${plan.shots.length} 张` : '');
        if (cardProgress.textContent !== cardProgressText) cardProgress.textContent = cardProgressText;
        renderShots(plan, results, { locked: shotsLocked, resultsLocked: locked, readyToReplan, canRetry, shotImageIssues,
            canAppendScene: currentPlan && !referenceIssue && !shotsLocked,
            shownShotId: latestShot?.id || savedCover?.shotId, referenceChanged, referenceVerificationPending, planNeedsReplan,
            exportRows: currentManifest.rows });
        detailDialog?.refresh();
        if (restoreFooterFocus) {
            if (focusPlanReview && plan) {
                const firstShot = plan.shots.find(shot => shot.source === 'generate');
                const target = shotRows.get(firstShot?.id)?.toggle || planHeading;
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'nearest' });
            } else {
                const target = [exportPrimary ? exportButton : null, fillButton, generateButton, planButton, blockerRecovery]
                    .find(button => button && !button.hidden && !button.disabled) || status;
                target.focus({ preventScroll: true });
            }
        }
        if (!busy) focusPlanReview = false;
    }

    function setShotSelection(value, ids) {
        preserveCommerceImageSetExportResults(value);
        const selected = getSelectedCommerceImageSetShots({ ...value, selectedShotIds: ids });
        const previous = new Map(value.plan?.shots.map(shot => [shot.id, shot]));
        const reducedSelection = value.plan?.platformId === value.platformId && selected.length > 0
            && selected.length < previous.size && selected.every(shot => {
                const prior = previous.get(shot.id);
                return prior?.source === shot.source && prior.aspect === shot.aspect;
            });
        value.selectedShotIds = selected.map(shot => shot.id);
        if (reducedSelection) {
            const projected = normalizeCommerceImageSetState(value);
            value.plan = projected.plan;
            value.results = projected.results;
            if (value.candidates) value.candidates = projected.candidates || [];
            activeShotId = '';
            runMessage = '';
            return;
        }
        if (value.candidates) {
            const aspects = new Map(selected.map(shot => [shot.id, shot.aspect]));
            value.candidates = value.candidates.filter(candidate => aspects.get(candidate.shotId) === candidate.aspect);
        }
        const compatible = new Set(selected.filter(shot => {
            const prior = previous.get(shot.id);
            return prior?.source === shot.source && (prior.source === 'reference' || prior.aspect === shot.aspect);
        }).map(shot => shot.id));
        const retained = value.results?.filter(result => result.status === 'completed' && compatible.has(result.shotId)) || [];
        const hasSceneDrafts = selected.some(shot => shot.customScene && previous.has(shot.id));
        if (value.plan && (hasSceneDrafts || (retained.length && (value.candidates?.length || retained.some(result => result.finalized))))) {
            const platformChanged = value.plan.platformId !== value.platformId;
            // A changed draft set establishes a new selection basis when it is planned again.
            delete value.plan.plannedShotIds;
            value.plan = {
                ...value.plan, platformId: value.platformId, confirmed: false, stale: true,
                shots: selected.map(shot => {
                    const prior = previous.get(shot.id);
                    const needsReview = shot.customScene && prior?.prompt && (platformChanged || prior.aspect !== shot.aspect);
                    return { prompt: '', ...(prior || { copy: '' }), ...shot,
                        ...(needsReview ? { sceneConfirmed: false, sceneNeedsReview: true } : {}) };
                })
            };
            value.results = platformChanged ? [] : retained;
        } else {
            value.plan = null;
            value.results = [];
        }
        activeShotId = '';
        runMessage = '';
    }

    function updateShotSelection(control) {
        const value = config();
        const selected = new Set(getSelectedCommerceImageSetShots(value).map(shot => shot.id));
        const id = control.dataset.commerceSelectShot;
        if (value.results?.some(result => result.shotId === id && result.finalized)) return;
        if (selected.has(id) === control.checked) return;
        if (control.checked) selected.add(id);
        else selected.delete(id);
        setShotSelection(value, [...selected]);
    }

    function updateSelect(control) {
        const field = control.dataset.commerceField;
        const value = config();
        if (field === 'candidateCount') {
            if (control.disabled) return;
            const count = normalizeCommerceImageSetCandidateCount(Number(control.value));
            if (count > 1) value.candidateCount = count;
            else delete value.candidateCount;
            return;
        }
        if (control.disabled && (field === 'platformId' || field.endsWith('Aspect'))
            && value.results?.some(result => result.finalized)) return;
        if (field === 'copyLanguage') {
            if (updateCommerceImageSetCopyLanguage(value, control.value)) {
                runMessage = '';
                configuration.open = true;
                setup.open = true;
                outputSettings.open = true;
            }
            return;
        }
        if (value[field] === control.value) return;
        value[field] = control.value;
        if (field === 'platformId') {
            const sceneIds = getSelectedCommerceImageSetShots(value).filter(shot => shot.customScene).map(shot => shot.id);
            delete value.candidates;
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
            if (field !== 'imageModelId' && field !== 'imageProviderId') {
                if (value.candidates?.length || value.results?.some(result => result.finalized)) value.plan.stale = true;
                else value.plan.sourceKey = '';
            }
        }
        runMessage = '';
    }

    artReset.addEventListener('click', () => {
        if (updateCommerceArtDirection(config(), '', { automatic: true })) {
            onChange();
            refresh();
        }
        artInput.focus();
    });
    element.addEventListener('change', event => {
        if (event.target.tagName === 'SELECT') updateSelect(event.target);
        else if (event.target.hasAttribute('data-commerce-select-shot')) updateShotSelection(event.target);
    });
    element.addEventListener('input', event => {
        if (event.target === artInput) {
            if (!updateCommerceArtDirection(config(), artInput.value)) return;
            onChange();
            refresh();
            return;
        }
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
            if (shot?.source !== 'generate' || value.results?.some(result => result.shotId === shot.id && result.finalized)) return;
            let change;
            if (field === 'description') {
                if (!shot.customScene || !updateCommerceSceneDescription(value, shot.id, event.target.value)) return;
                shotNotices.delete(shot.id);
                change = { commerceShotId: shot.id, commerceSceneChanged: true };
            } else {
                if (field !== 'prompt' && !(shot.allowCopy && field === 'copy')) return;
                const current = field === 'copy' ? getCommerceShotCopy(shot) : shot.prompt || '';
                if (current === event.target.value) return;
                shot[field] = event.target.value;
                if (shot.customScene) shot.sceneConfirmed = false;
                else value.plan.confirmed = false;
                change = { commerceShotId: shot.id, commerceShotField: field };
            }
            runMessage = '';
            onChange(change);
            refresh();
            return;
        } else return;
        runMessage = '';
    });
    const isCurrentNode = () => state.nodes.get(node.id) === node;

    function detailData() {
        const value = config();
        const options = exportInput(value, projectCommerceReferences(state, node.id));
        const manifest = projectCommerceImageSetExport({ ...options, scope: 'detail' });
        const finalized = new Set((value.results || []).filter(row => row.finalized).map(row => row.shotId));
        return {
            sections: manifest.rows.map(({ shotId, label, assetKey, status }) => ({
                shotId, label, image: assetUrl(assetKey), previous: status === 'previous', finalized: finalized.has(shotId)
            })),
            busy: !!(pendingAction || pendingShots.size || state.runningNodeIds?.has(node.id)),
            editable: isCurrentNode() && node.enabled !== false && node.isClone !== true && !value.plan?.stale && !options.styleChanged
                && value.plan?.detailPage?.version === 2 && !options.referenceChanged && !options.referenceVerificationPending
        };
    }

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

    async function runDetailAction(action, shotId, options) {
        const outcome = await run(action, shotId, options);
        if (outcome?.outcome !== 'completed') throw new Error(runError(outcome) || '操作未完成，请重试。');
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
        if (action === 'analyze' || action === 'plan') productMessage = '';
        refresh();
        try {
            const result = await run(action);
            runMessage = result?.outcome === 'stopped' ? '已取消套图任务。' : runError(result);
            if (action === 'plan' && !runMessage) {
                activeShotId = '';
                setup.open = !config().plan;
                focusPlanReview = Boolean(config().plan);
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
        if (!button || button.hidden || button.disabled || button.getAttribute('aria-disabled') === 'true'
            || button.closest('.commerce-image-set-shot-secondary-actions[hidden]')) return;
        const action = button.dataset.commerceAction;
        if (action === 'resolve-blocker') {
            recoverBlocker?.();
            return;
        }
        if (action === 'choose-shots') {
            configuration.open = true;
            setup.open = true;
            const firstChoice = shotSelection.querySelector('input[data-commerce-select-shot]:enabled');
            firstChoice?.focus({ preventScroll: true });
            firstChoice?.closest('label').scrollIntoView({ block: 'nearest', inline: 'nearest' });
            return;
        }
        const shotRow = button.closest('[data-commerce-shot-id]');
        const shotId = shotRow?.dataset.commerceShotId;
        if (action === 'remove-scene') {
            const shot = config().plan?.shots.find(item => item.id === shotId);
            if (!shot?.customScene) return;
            const confirmed = await confirmAction({
                documentRef, title: '删除场景图', message: `从当前套图删除「${shot.label}」？`,
                confirmLabel: '删除场景图', danger: true
            });
            if (!confirmed || !isCurrentNode() || !button.isConnected || button.disabled) return;
            if (!await removeScene(shotId)) {
                runMessage = '暂时无法删除场景图，请在任务结束后重试。';
                refresh();
                return;
            }
            shotNotices.delete(shotId);
            if (activeShotId === shotId) activeShotId = '';
            runMessage = '';
            onChange();
            refresh();
            const groupAdd = resultGroups.get(shot.group)?.add;
            (groupAdd?.disabled ? planButton : groupAdd)?.focus({ preventScroll: true });
            return;
        }
        if (action === 'toggle-final') {
            const value = config();
            const finalized = value.results?.find(result => result.shotId === shotId)?.finalized === true;
            if (setCommerceShotFinalized(value, shotId, !finalized)) {
                onChange({ commerceShotId: shotId, commerceFinalizedChanged: true });
                refresh();
            }
            return;
        }
        if (action === 'compare-shot') {
            if (closeCandidateDialog || documentRef.getElementById('commerce-candidates-dialog')) return;
            const value = config();
            const shot = value.plan?.shots.find(item => item.id === shotId);
            const result = value.results?.find(item => item.shotId === shotId && item.status === 'completed');
            const { current, candidates } = shotVersions(shotId, result);
            if (!shot || (!current && !candidates.length)) return;
            try {
                closeCandidateDialog = openCommerceShotCandidates({
                    documentRef, opener: button, shot, current, candidates, finalized: result?.finalized === true, getAssetUrl: assetUrl,
                    generationIssue: shotRows.get(shotId)?.generationIssue,
                    openPreview: openResultPreview,
                    candidateCount: normalizeCommerceImageSetCandidateCount(value.candidateCount),
                    onCancel: () => cancel(shotId),
                    onGenerate: async count => {
                        const outcome = await run('generate-candidates', shotId, { commerceCandidateCount: count });
                        const updated = config();
                        const versions = shotVersions(shotId, updated.results?.find(row => row.shotId === shotId));
                        if (outcome?.outcome === 'failed') throw new Error(runError(outcome) || '候选生成失败。');
                        if (outcome?.outcome !== 'completed' && outcome?.outcome !== 'stopped') throw new Error(runError(outcome) || '未能开始生成候选。');
                        return { ...versions, message: outcome?.outcome === 'stopped' ? '已停止生成，已保存的候选可继续选择。' : '' };
                    },
                    onApply: async key => {
                        const outcome = await run('select-candidate', shotId, { commerceCandidateKey: key });
                        if (outcome?.outcome !== 'completed') throw new Error(runError(outcome) || '采用版本已取消。');
                        activeShotId = shotId;
                        shotNotices.delete(shotId);
                        if (isCurrentNode()) refresh();
                    },
                    onClose: () => { closeCandidateDialog = null; }
                });
            } catch (error) {
                runMessage = error?.message || '无法打开候选对比。';
                refresh();
            }
            return;
        }
        if (action === 'preview-detail-page') {
            if (detailDialog || documentRef.getElementById('commerce-detail-page-dialog')) return;
            try {
                detailDialog = openCommerceDetailPage({
                    documentRef, opener: button, getPage: detailData,
                    onLayout: (id, text) => runDetailAction('revise-detail-page', id, { commerceDetailDirection: text }),
                    onClose: () => { detailDialog = null; }
                });
            } catch (error) {
                runMessage = error?.message || '无法打开详情图预览。';
                refresh();
            }
            return;
        }
        if (action === 'preview-previous' || action === 'export') {
            const options = exportInput(config(), projectCommerceReferences(state, node.id));
            if (options.referenceVerificationPending) return;
            const previous = projectCommerceImageSetExport({ ...options, version: 'previous' });
            if (action === 'preview-previous') {
                const images = previous.rows.map(row => assetUrl(row.assetKey)).filter(Boolean);
                if (images.length) await openResultPreview(images, 0, () => {
                    if (button.isConnected && !button.closest('[hidden], [inert]')) button.focus({ preventScroll: true });
                });
                return;
            }
            if (closeExportDialog || documentRef.getElementById('commerce-export-dialog')) return;
            const manifest = projectCommerceImageSetExport(options);
            try {
                closeExportDialog = openCommerceImageSetExport({
                    manifest, previousManifest: hasExportImages(previous) ? previous : null,
                    initialVersion: initialExportVersion(manifest, previous),
                    documentRef, opener: button, onClose: () => { closeExportDialog = null; }
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
            if (shot && (result?.status === 'failed' || result?.replacementError)) {
                openShotError(shot.label, result.replacementError || result.error || '本次生成未返回图片。');
            }
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
    return {
        element, actions, refresh,
        destroy() {
            designReferences.destroy();
            detailDialog?.close();
            closeExportDialog?.();
            closeCandidateDialog?.();
            clearShotRows();
        }
    };
}
