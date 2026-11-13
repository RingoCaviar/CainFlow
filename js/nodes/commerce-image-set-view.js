import {
    COMMERCE_IMAGE_SET_ASPECTS, COMMERCE_IMAGE_SET_COPY_LIMITS, COMMERCE_IMAGE_SET_DEFAULT_ASPECTS,
    COMMERCE_IMAGE_SET_PRESETS, getSelectedCommerceImageSetShots
} from '../features/ecommerce-image-set/commerce-image-set-plan.js';
import { getEffectiveProtocol, getModelProviders, getModelsForTask } from '../features/execution/provider-request-utils.js';
import { getOpenAIChatCapabilities } from '../features/execution/openai-chat-capabilities.js';
import { projectImageReferences } from './image-reference-projection.js';

const shotGroups = [['gallery', '主副图'], ['detail', '详情图']];
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

export function createCommerceImageSetView({ node, state, documentRef, run, waitForNodeRun, onChange, openResultPreview, openShotError, bindReferencePrompt }) {
    const card = node.el.querySelector('.commerce-image-set-card');
    const cover = card.querySelector('img');
    const cardTitle = card.querySelector('.commerce-image-set-card-title');
    const cardProgress = card.querySelector('.commerce-image-set-card-progress');
    const editorIdPrefix = `commerce-shot-editor-${++panelSequence}`;
    const element = documentRef.createElement('section');
    element.className = 'commerce-image-set-settings';
    element.innerHTML = `<details class="commerce-image-set-setup" open>
        <summary hidden><strong>生成设置</strong><span></span></summary>
        <div class="commerce-image-set-setup-fields">
            <div class="commerce-image-set-platform">
                <label>平台<select data-commerce-field="platformId"></select></label>
                <p class="commerce-image-set-guide"></p>
            </div>
            <div class="commerce-image-set-selection">
                ${shotGroups.map(([group, title]) => `<section class="commerce-image-set-choice-group">
                    <div class="commerce-image-set-group-heading">
                        <h3>${title}</h3>
                        <label>比例<select data-commerce-field="${group}Aspect" aria-label="${title}比例"></select></label>
                    </div>
                    <div class="commerce-image-set-shot-choices" data-commerce-choice-group="${group}" role="group" aria-label="${title}图位"></div>
                </section>`).join('')}
                <p class="commerce-image-set-selection-hint" role="status">请至少勾选一个图位。</p>
            </div>
            <details class="commerce-image-set-disclosure">
                <summary>商品资料（可选）</summary>
                <textarea data-commerce-field="productNotes" aria-label="商品资料" rows="2" maxlength="4000" placeholder="补充已确认的材质、尺寸或规格"></textarea>
            </details>
            <details class="commerce-image-set-disclosure">
                <summary>模型与供应商</summary>
                <div class="commerce-image-set-options">
                    <label>规划模型<select data-commerce-field="plannerModelId"></select></label>
                    <label>规划供应商<select data-commerce-field="plannerProviderId"></select></label>
                    <label>生图模型<select data-commerce-field="imageModelId"></select></label>
                    <label>生图供应商<select data-commerce-field="imageProviderId"></select></label>
                </div>
            </details>
        </div>
    </details>
    <section class="commerce-image-set-plan" aria-label="套图方案" hidden>
        <header class="commerce-image-set-plan-heading">
            <h3>套图方案</h3>
            <details class="commerce-image-set-disclosure">
                <summary>商品卖点</summary>
                <textarea data-commerce-selling-points aria-label="商品卖点" rows="3" maxlength="2400" placeholder="每行一个卖点"></textarea>
            </details>
        </header>
        <div class="commerce-image-set-shots"></div>
    </section>`;
    const actions = documentRef.createElement('div');
    actions.className = 'commerce-image-set-footer';
    actions.innerHTML = `<p class="commerce-image-set-status" role="status"></p>
        <progress class="commerce-image-set-progress" aria-label="套图生成进度" hidden></progress>
        <div class="commerce-image-set-actions">
            <button type="button" class="btn btn-primary" data-commerce-action="plan">生成方案</button>
            <button type="button" class="btn btn-primary" data-commerce-action="generate" hidden>确认并生成套图</button>
        </div>`;
    const fields = Object.fromEntries(Array.from(element.querySelectorAll('[data-commerce-field]'), control => [control.dataset.commerceField, control]));
    const setup = element.querySelector('.commerce-image-set-setup');
    const setupSummary = setup.querySelector('summary');
    const setupSelection = setupSummary.querySelector('span');
    const guide = element.querySelector('.commerce-image-set-guide');
    const shotSelection = element.querySelector('.commerce-image-set-selection');
    const choiceGroups = new Map(shotGroups.map(([group]) => [group, shotSelection.querySelector(`[data-commerce-choice-group="${group}"]`)]));
    const shotSelectionHint = shotSelection.querySelector('.commerce-image-set-selection-hint');
    const planSection = element.querySelector('.commerce-image-set-plan');
    const sellingPoints = element.querySelector('[data-commerce-selling-points]');
    const shots = element.querySelector('.commerce-image-set-shots');
    const planButton = actions.querySelector('[data-commerce-action="plan"]');
    const generateButton = actions.querySelector('[data-commerce-action="generate"]');
    const status = actions.querySelector('.commerce-image-set-status');
    const progressBar = actions.querySelector('progress');
    const actionButtons = actions.querySelector('.commerce-image-set-actions');
    const defaultPlatformId = Object.keys(COMMERCE_IMAGE_SET_PRESETS)[0];
    const config = () => (node.data.commerceImageSet ??= { platformId: defaultPlatformId, selectedShotIds: [] });
    const shotRows = new Map();
    const optionKeys = new WeakMap();
    const queuedRetries = new Set();
    let pendingAction = null;
    let drainingRetries = false;
    let runMessage = '';
    let shotStructure = '';
    let choicePlatform = '';
    let activeShotId = '';
    let planSourceKey = null;

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
                    label.append(checkbox, name);
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
        row.tabIndex = -1;
        row.innerHTML = `<div class="commerce-image-set-shot-summary">
            <button type="button" class="commerce-image-set-shot-preview" data-commerce-action="preview" data-node-read-action aria-pressed="false" hidden><img loading="lazy" hidden></button>
            <div class="commerce-image-set-shot-info">
                <button type="button" class="commerce-image-set-shot-toggle" data-node-read-action aria-expanded="false">
                    <span class="commerce-image-set-shot-heading"><span class="commerce-image-set-shot-name"><span class="commerce-image-set-shot-chevron" aria-hidden="true"></span><strong></strong></span><span class="commerce-image-set-shot-aspect"></span></span>
                </button>
                <div class="commerce-image-set-shot-status-slot">
                    <span class="commerce-image-set-shot-status"></span>
                    <button type="button" class="image-parameter-failure-button" data-commerce-action="error-detail"
                        data-node-read-action aria-haspopup="dialog" title="查看错误详情" hidden>生成失败</button>
                </div>
                <div class="commerce-image-set-shot-tools" hidden>
                    <button type="button" class="commerce-image-set-shot-action" data-commerce-action="replan-shot">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v2M13 3v5h5M8 12h4M8 16h2"/><path d="m13 17 5.5-5.5a1.4 1.4 0 0 1 2 2L15 19l-3 1z"/></svg>
                    </button>
                    <button type="button" class="commerce-image-set-shot-action" data-commerce-action="retry" data-node-read-action>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5M3 16l4-4 3 3 3-3"/><circle cx="8" cy="8" r="1"/><path d="M21 14v4h-4m4 0a4 4 0 1 0-1.1 3.2"/></svg>
                    </button>
                </div>
                <span class="commerce-image-set-copy-summary" hidden></span>
            </div>
        </div>
        <div class="commerce-image-set-shot-editor" hidden>
            <p class="commerce-image-set-shot-purpose" hidden></p>
            ${shot.source === 'generate' ? `<div class="commerce-image-set-copy-fields">
                <label>图中文字标题<input type="text" data-commerce-shot-field="headline" maxlength="${COMMERCE_IMAGE_SET_COPY_LIMITS.headline}"></label>
                <label>图中文字正文<textarea data-commerce-shot-field="body" rows="2" maxlength="${COMMERCE_IMAGE_SET_COPY_LIMITS.body}"></textarea></label>
            </div>
            <label>生图提示词<textarea data-commerce-shot-field="prompt" rows="3" maxlength="2000"></textarea></label>` : ''}
        </div>`;
        row.querySelector('strong').textContent = shot.label;
        row.querySelector('.commerce-image-set-shot-aspect').textContent = shot.source === 'reference' ? '沿用第一张参考图' : (shot.aspect || '');
        const editor = row.querySelector('.commerce-image-set-shot-editor');
        const toggle = row.querySelector('.commerce-image-set-shot-toggle');
        const message = row.querySelector('.commerce-image-set-shot-status');
        const failure = row.querySelector('[data-commerce-action="error-detail"]');
        failure.setAttribute('aria-label', `查看「${shot.label}」生成失败详情`);
        editor.id = `${editorIdPrefix}-${shot.id}`;
        message.id = `${editor.id}-status`;
        toggle.setAttribute('aria-controls', editor.id);
        toggle.setAttribute('aria-describedby', message.id);
        toggle.setAttribute('aria-label', shot.label);
        const purpose = editor.querySelector('.commerce-image-set-shot-purpose');
        purpose.textContent = shot.purpose || '';
        purpose.hidden = !shot.purpose;
        const copyFields = editor.querySelector('.commerce-image-set-copy-fields');
        if (copyFields) copyFields.hidden = !shot.allowCopy;
        const shotFields = Array.from(editor.querySelectorAll('[data-commerce-shot-field]'));
        const destroyPrompt = bindReferencePrompt?.(node, editor.querySelector('[data-commerce-shot-field="prompt"]'));
        const image = row.querySelector('img');
        image.alt = shot.label;
        const preview = row.querySelector('[data-commerce-action="preview"]');
        preview.setAttribute('aria-label', `打开${shot.label}预览`);
        row.querySelector('.commerce-image-set-shot-tools').hidden = shot.source !== 'generate';
        const replan = row.querySelector('[data-commerce-action="replan-shot"]');
        replan.title = `重新生成${shot.label}方案`;
        replan.setAttribute('aria-label', replan.title);
        const retry = row.querySelector('[data-commerce-action="retry"]');
        row.addEventListener('click', event => {
            if (event.target.closest('[data-commerce-action], .commerce-image-set-shot-editor')) return;
            const expand = editor.hidden;
            for (const [id, item] of shotRows) {
                const expanded = expand && id === shot.id;
                if (item.editor.hidden !== expanded) continue;
                item.editor.hidden = !expanded;
                item.toggle.setAttribute('aria-expanded', String(expanded));
            }
        });
        return { row, editor, toggle, shotFields, image, preview, replan, retry, failure, destroyPrompt,
            message, copySummary: row.querySelector('.commerce-image-set-copy-summary') };
    }

    function getShotPreview(shotId) {
        return node.commerceShotPreviews?.[shotId];
    }

    function clearShotRows() {
        for (const row of shotRows.values()) row.destroyPrompt?.();
        shotRows.clear();
    }

    function renderShots(plan, results, { locked, readyToReplan, canRetry, shownShotId }) {
        const planShots = plan?.shots || [];
        const structure = JSON.stringify(planShots.map(({ id, label, aspect, source, group, allowCopy, purpose }) => [id, label, aspect, source, group, allowCopy, purpose]));
        if (structure !== shotStructure) {
            clearShotRows();
            const groups = [];
            for (const [group, title] of shotGroups) {
                const groupShots = planShots.filter(shot => (shot.group || 'gallery') === group);
                if (!groupShots.length) continue;
                const section = documentRef.createElement('section');
                section.className = 'commerce-image-set-result-group';
                const header = documentRef.createElement('header');
                header.className = 'commerce-image-set-group-heading';
                const heading = documentRef.createElement('h4');
                heading.textContent = title;
                const count = documentRef.createElement('span');
                count.textContent = `${groupShots.length} 张`;
                header.append(heading, count);
                section.append(header);
                for (const shot of groupShots) {
                    const row = makeShotRow(shot);
                    shotRows.set(shot.id, row);
                    section.append(row.row);
                }
                groups.push(section);
            }
            shots.replaceChildren(...groups);
            shotStructure = structure;
        }
        const savedResults = new Map(results.map(result => [result.shotId, result]));
        for (const shot of planShots) {
            const row = shotRows.get(shot.id);
            const savedResult = savedResults.get(shot.id);
            const liveResult = getShotPreview(shot.id);
            const result = liveResult || savedResult;
            for (const field of row.shotFields) {
                if (documentRef.activeElement !== field) field.value = shot[field.dataset.commerceShotField] || '';
                field.disabled = locked;
            }
            const copy = shot.allowCopy ? [shot.headline, shot.body].filter(Boolean).join(' · ') : '';
            if (row.copySummary.textContent !== copy) row.copySummary.textContent = copy;
            row.copySummary.hidden = !copy;
            const previewUrl = result?.image || assetUrl(savedResult?.assetKey);
            setImage(row.image, previewUrl);
            row.preview.hidden = !previewUrl;
            row.preview.setAttribute('aria-pressed', String(shownShotId === shot.id));
            const failed = result?.status === 'failed';
            const activeRetry = pendingAction?.action === 'retry' && pendingAction.shotId === shot.id;
            const running = result?.status === 'running' || (activeRetry && (!liveResult || liveResult.status === 'pending'));
            const queued = queuedRetries.has(shot.id);
            const resultStatus = running ? 'running' : queued ? 'queued' : result?.status || 'pending';
            const message = running ? '正在生成' : queued ? '排队重试' : failed ? '生成失败'
                : resultStatus === 'completed' ? '已完成' : shot.source === 'reference' ? '待应用' : '待生成';
            if (row.message.textContent !== message) row.message.textContent = message;
            row.row.dataset.resultStatus = resultStatus;
            row.message.hidden = resultStatus === 'failed';
            row.failure.hidden = resultStatus !== 'failed';
            row.replan.disabled = locked || !readyToReplan;
            row.retry.disabled = !canRetry || running || queued || activeRetry || liveResult?.status === 'pending';
            const label = queued ? `${shot.label}图片已排队重试`
                : `${savedResult?.status === 'completed' ? '重新生成' : failed ? '重试' : '生成'}${shot.label}图片`;
            if (row.retry.title !== label) {
                row.retry.title = label;
                row.retry.setAttribute('aria-label', label);
            }
        }
    }

    function refresh() {
        const value = config();
        const platformId = Object.hasOwn(COMMERCE_IMAGE_SET_PRESETS, value.platformId) ? value.platformId : defaultPlatformId;
        const preset = COMMERCE_IMAGE_SET_PRESETS[platformId];
        const selectedShots = getSelectedCommerceImageSetShots(value);
        const needsImageModel = selectedShots.some(shot => shot.source === 'generate');
        const planner = modelOptions('chat', value.plannerModelId, value.plannerProviderId);
        const image = modelOptions('image', value.imageModelId, value.imageProviderId);
        const references = projectImageReferences({ state, targetId: node.id });
        const referenceIssue = references.count > 5 ? '套图最多使用 5 张参考图，请调整输入。'
            : references.groups.some(group => group.running) ? '请等待参考图来源运行完成。'
            : !references.count || references.slots.some(slot => slot.missing) ? '请连接 1 至 5 张可读取的商品参考图。' : '';
        const busy = pendingAction || drainingRetries || state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus);
        const unavailable = node.enabled === false || node.isClone === true;
        const locked = busy || unavailable;
        const plan = value.plan;
        if ((plan?.sourceKey ?? null) !== planSourceKey) {
            planSourceKey = plan?.sourceKey ?? null;
            activeShotId = '';
            setup.open = !plan?.sourceKey;
        }
        setupSummary.hidden = !plan;
        const selectionLabel = `${preset.label} · ${selectedShots.length} 个图位`;
        if (setupSelection.textContent !== selectionLabel) setupSelection.textContent = selectionLabel;
        const results = Array.isArray(value.results) ? value.results : [];
        const { completed: processed, total } = node.apiGenerationProgress || {};
        const progress = busy && Number.isInteger(processed) && Number.isInteger(total)
            && total > 0 && processed >= 0 && processed <= total ? `正在生成图片（${processed} / ${total}）` : '';
        const missingPrompt = plan?.shots.some(shot => shot.source === 'generate' && !shot.prompt?.trim());
        const currentPlan = !!plan?.sourceKey && plan.platformId === platformId && selectedShots.length > 0
            && plan.shots.length === selectedShots.length && plan.shots.every((shot, index) => (
                shot.id === selectedShots[index].id && shot.aspect === selectedShots[index].aspect
            ));
        const readyToGenerate = currentPlan && !referenceIssue && (!needsImageModel || image.ready) && !missingPrompt;
        const readyToReplan = currentPlan && !referenceIssue && planner.ready && !missingPrompt;
        const canRetry = readyToGenerate && !unavailable
            && (!busy || node.commerceShotPreviews || pendingAction?.action === 'retry' || drainingRetries);
        setOptions(fields.platformId, Object.values(COMMERCE_IMAGE_SET_PRESETS).map(item => [item.id, item.label]), platformId);
        for (const [group] of shotGroups) {
            const field = `${group}Aspect`;
            setOptions(fields[field], COMMERCE_IMAGE_SET_ASPECTS.map(aspect => [aspect, aspect]), value[field] || COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group]);
        }
        for (const [prefix, options] of [['planner', planner], ['image', image]]) {
            setOptions(fields[`${prefix}ModelId`], options.models.map(model => [model.id, model.name || model.modelId]), value[`${prefix}ModelId`], '选择模型');
            setOptions(fields[`${prefix}ProviderId`], options.providers.map(provider => [provider.id, provider.name || provider.id]), value[`${prefix}ProviderId`], '选择供应商');
        }
        for (const control of Object.values(fields)) control.disabled = locked;
        if (documentRef.activeElement !== fields.productNotes) fields.productNotes.value = value.productNotes || '';
        guide.textContent = Array.isArray(preset.guide) ? preset.guide.join(' ') : (preset.guide || '');
        renderShotChoices(preset, selectedShots, locked);
        planSection.hidden = !plan;
        if (documentRef.activeElement !== sellingPoints) sellingPoints.value = (plan?.sellingPoints || []).join('\n');
        sellingPoints.disabled = locked;
        planButton.textContent = plan ? '重新规划' : '生成方案';
        planButton.classList.toggle('btn-primary', !currentPlan);
        planButton.classList.toggle('btn-secondary', currentPlan);
        planButton.disabled = locked || !selectedShots.length || !!referenceIssue || !planner.ready;
        generateButton.hidden = !currentPlan;
        generateButton.disabled = locked || !readyToGenerate;
        actionButtons.hidden = busy;
        progressBar.hidden = !progress;
        if (progress) {
            progressBar.max = total;
            progressBar.value = processed;
        }
        const hint = referenceIssue || (!currentPlan && !planner.ready ? '请在「模型与供应商」中选择支持图片输入的规划模型。'
            : plan && !currentPlan ? '生成设置已修改，请重新规划。'
                : currentPlan && needsImageModel && !image.ready ? '请在「模型与供应商」中选择生图模型和供应商。'
                    : missingPrompt ? '请填写每张待生成图片的提示词。' : '');
        const runningLabel = node.runStatus === 'running' ? '正在执行…' : '等待执行…';
        const statusMessage = busy ? progress || runMessage || runningLabel : runMessage || hint;
        if (status.textContent !== statusMessage) status.textContent = statusMessage;
        const completed = results.filter(result => result.status === 'completed' && !getShotPreview(result.shotId));
        const priorAssets = completed.length ? [] : (node.data.mediaAssetKeys || []).filter(assetUrl);
        // The runtime produces shots in plan order, so the last completed preview is the newest.
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
        cardProgress.textContent = progress || (priorAssets.length ? `上次套图 · ${priorAssets.length} 张`
            : plan ? `${completed.length} / ${plan.shots.length} 张` : '');
        renderShots(plan, results, { locked, readyToReplan, canRetry, shownShotId: latestShot?.id || savedCover?.shotId });
    }

    function setShotSelection(value, ids) {
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
        if (value[field] === control.value) return;
        value[field] = control.value;
        if (field === 'platformId') {
            setShotSelection(value, []);
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
        if (event.target === fields.productNotes) {
            value.productNotes = event.target.value;
            if (value.plan) { value.plan.confirmed = false; value.plan.sourceKey = ''; }
        } else if (value.plan && event.target === sellingPoints) {
            value.plan.sellingPoints = sellingPoints.value.split('\n').map(line => line.trim()).filter(Boolean);
            value.plan.confirmed = false;
        } else if (value.plan && event.target.dataset.commerceShotField) {
            const field = event.target.dataset.commerceShotField;
            const shot = value.plan.shots.find(item => item.id === event.target.closest('[data-commerce-shot-id]')?.dataset.commerceShotId);
            if (shot?.source !== 'generate' || field !== 'prompt' && !(shot.allowCopy && Object.hasOwn(COMMERCE_IMAGE_SET_COPY_LIMITS, field))) return;
            shot[field] = event.target.value;
            value.plan.confirmed = false;
        } else return;
        runMessage = '';
    });
    const isCurrentNode = () => state.nodes.get(node.id) === node;

    function restoreActionFocus(row, button) {
        if (row && documentRef.activeElement === row && !button.disabled && button.checkVisibility()) {
            button.focus({ preventScroll: true });
        }
    }

    async function runAction(action, shotId) {
        const actionShot = shotId ? config().plan?.shots.find(shot => shot.id === shotId) : null;
        pendingAction = { action, shotId };
        runMessage = action === 'plan' ? '正在规划套图…'
            : action === 'replan-shot' && actionShot ? `正在重新规划「${actionShot.label}」…`
                : actionShot ? `正在生成「${actionShot.label}」图片…` : '正在生成图片…';
        if (action === 'generate') {
            config().plan.confirmed = true;
            onChange();
        }
        refresh();
        try {
            const result = await run(action, shotId);
            const nodeError = result?.nodeResults?.find(item => item.nodeId === node.id)?.error;
            runMessage = result?.error || nodeError || (result?.outcome === 'stopped' ? '执行已停止。'
                : result?.outcome === 'failed' ? '执行失败。'
                    : result === false || result?.executed === false ? '执行未启动。' : '');
            if (action === 'plan' && !runMessage) {
                activeShotId = '';
                setup.open = !config().plan;
            }
            if (action === 'replan-shot' && actionShot && !runMessage) runMessage = `「${actionShot.label}」方案已更新。`;
            return result !== false && result?.executed !== false && result?.outcome !== 'stopped' && node.runStatus !== 'aborted';
        } catch (error) {
            runMessage = error?.message || '执行失败。';
            return false;
        } finally {
            pendingAction = null;
            if (isCurrentNode()) {
                if (action === 'retry' && actionShot && runMessage && config().results?.some(row => row.shotId === shotId && row.status === 'completed')) {
                    runMessage = `「${actionShot.label}」重试未完成，已保留上一张图片。${runMessage}`;
                }
                refresh();
            }
        }
    }

    async function drainRetries() {
        if (pendingAction || drainingRetries || !queuedRetries.size) return;
        drainingRetries = true;
        try {
            if (!isCurrentNode() || !(await waitForNodeRun())) return;
            for (const shotId of queuedRetries) {
                if (!isCurrentNode()) return;
                queuedRetries.delete(shotId);
                refresh();
                const shotView = shotRows.get(shotId);
                if (!shotView || shotView.retry.disabled) continue;
                const canContinue = await runAction('retry', shotId);
                restoreActionFocus(shotView.row, shotView.retry);
                if (!canContinue) return;
            }
        } catch (error) {
            runMessage = error?.message || '无法继续重试。';
        } finally {
            queuedRetries.clear();
            drainingRetries = false;
            if (isCurrentNode()) refresh();
        }
    }

    async function handleAction(event) {
        const button = event.target.closest('[data-commerce-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.commerceAction;
        const shotRow = button.closest('[data-commerce-shot-id]');
        const shotId = shotRow?.dataset.commerceShotId;
        if (action === 'error-detail') {
            if (button.hidden) return;
            const value = config();
            const shot = value.plan?.shots.find(item => item.id === shotId);
            const result = getShotPreview(shotId) || value.results?.find(item => item.shotId === shotId);
            if (shot && result?.status === 'failed') openShotError(shot.label, result.error || '本次生成未返回图片。');
            return;
        }
        if (action === 'preview') {
            const available = Array.from(shotRows, ([id, { image }]) => ({ id, src: image.getAttribute('src') }))
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
        const actionRow = documentRef.activeElement === button ? shotRow : null;
        actionRow?.focus({ preventScroll: true });
        if (action === 'retry') {
            queuedRetries.add(shotId);
            refresh();
            await drainRetries();
            return;
        }
        if (!pendingAction && !drainingRetries) {
            if (await runAction(action, shotId)) await drainRetries();
            else if (queuedRetries.size) {
                queuedRetries.clear();
                if (isCurrentNode()) refresh();
            }
        }
        restoreActionFocus(actionRow, button);
    }
    element.addEventListener('click', handleAction);
    actions.addEventListener('click', handleAction);
    return { element, actions, refresh, destroy: clearShotRows };
}
