const dialogState = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeActions(actions) {
    if (Array.isArray(actions) && actions.length > 0) return actions;
    return [
        { id: 'cancel', label: '取消', variant: 'secondary' },
        { id: 'confirm', label: '确定', variant: 'primary', autofocus: true }
    ];
}

function normalizeInput(input) {
    if (!input) return null;
    const normalized = typeof input === 'object' ? input : {};
    return {
        id: normalized.id || 'dialog-style-1-input',
        label: normalized.label || '',
        value: normalized.value ?? '',
        placeholder: normalized.placeholder || '',
        maxLength: normalized.maxLength || '',
        autocomplete: normalized.autocomplete || 'off',
        autofocus: normalized.autofocus !== false,
        rejectPattern: normalized.rejectPattern instanceof RegExp ? normalized.rejectPattern : null,
        onReject: typeof normalized.onReject === 'function' ? normalized.onReject : null
    };
}

function resetPattern(pattern) {
    if (pattern) pattern.lastIndex = 0;
}

function hasRejectedInput(value, pattern) {
    if (!pattern) return false;
    resetPattern(pattern);
    return pattern.test(String(value ?? ''));
}

function sanitizeInputValue(value, pattern) {
    if (!pattern) return String(value ?? '');
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    return String(value ?? '').replace(globalPattern, '');
}

function getNextInputValue(input, text) {
    const value = input.value ?? '';
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    return `${value.slice(0, start)}${text ?? ''}${value.slice(end)}`;
}

function insertTextIntoInput(input, text) {
    if (typeof input.setRangeText === 'function') {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.setRangeText(text, start, end, 'end');
    } else {
        input.value = getNextInputValue(input, text);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createRejectFeedback(targets, onReject) {
    const feedbackTargets = targets.filter(Boolean);
    let rejectTimer = 0;
    return () => {
        feedbackTargets.forEach((target) => target.classList.remove('is-rejecting'));
        void feedbackTargets[0]?.offsetWidth;
        feedbackTargets.forEach((target) => target.classList.add('is-rejecting'));
        window.clearTimeout(rejectTimer);
        rejectTimer = window.setTimeout(() => {
            feedbackTargets.forEach((target) => target.classList.remove('is-rejecting'));
        }, 520);
        onReject?.();
    };
}

function getDialogElement({ id, documentRef }) {
    let dialog = documentRef.getElementById(id);
    if (dialog) return dialog;
    dialog = documentRef.createElement('div');
    dialog.id = id;
    dialog.className = 'dialog-style-1 hidden';
    (documentRef.body || documentRef.documentElement).appendChild(dialog);
    return dialog;
}

function resolveDialog({ id, documentRef, actionId }) {
    const dialog = getDialogElement({ id, documentRef });
    const state = dialogState.get(id);
    const result = state?.getValue ? { actionId, value: state.getValue() } : actionId;

    dialog.classList.add('hidden');
    dialog.onkeydown = null;
    dialog.onclick = null;
    dialog.innerHTML = '';

    dialogState.delete(id);
    state?.resolve?.(result);
}

export function openDialogStyle1({
    id = 'dialog-style-1',
    title = '',
    message = '',
    note = '',
    input = null,
    actions,
    cancelActionId = 'cancel',
    submitActionId = 'confirm',
    labelledBy = `${id}-title`,
    documentRef = document
} = {}) {
    if (dialogState.has(id)) {
        resolveDialog({ id, documentRef, actionId: cancelActionId });
    }

    const dialog = getDialogElement({ id, documentRef });
    const normalizedActions = normalizeActions(actions);
    const normalizedInput = normalizeInput(input);
    const actionButtons = normalizedActions.map((action) => {
        const variant = action.variant || 'secondary';
        const variantClass = variant === 'primary' ? 'btn-primary'
            : variant === 'danger' ? 'btn-danger'
                : 'btn-secondary';
        const autofocus = action.autofocus ? ' data-dialog-style-1-autofocus="true"' : '';
        return `<button type="button" class="btn ${variantClass}" data-dialog-style-1-action="${escapeHtml(action.id)}"${autofocus}>${escapeHtml(action.label)}</button>`;
    }).join('');

    dialog.innerHTML = `
        <div class="dialog-style-1-backdrop" data-dialog-style-1-action="${escapeHtml(cancelActionId)}"></div>
        <div class="dialog-style-1-panel" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(labelledBy)}" tabindex="-1">
            <div class="dialog-style-1-header">
                <h3 id="${escapeHtml(labelledBy)}">${escapeHtml(title)}</h3>
                <button type="button" class="dialog-style-1-close" data-dialog-style-1-action="${escapeHtml(cancelActionId)}" title="关闭">×</button>
            </div>
            <div class="dialog-style-1-body">
                ${message ? `<p class="dialog-style-1-message">${escapeHtml(message)}</p>` : ''}
                ${normalizedInput ? `
                <label class="dialog-style-1-field" for="${escapeHtml(normalizedInput.id)}">
                    ${normalizedInput.label ? `<span>${escapeHtml(normalizedInput.label)}</span>` : ''}
                    <input
                        id="${escapeHtml(normalizedInput.id)}"
                        type="text"
                        value="${escapeHtml(normalizedInput.value)}"
                        placeholder="${escapeHtml(normalizedInput.placeholder)}"
                        autocomplete="${escapeHtml(normalizedInput.autocomplete)}"
                        data-dialog-style-1-input="true"
                        ${normalizedInput.maxLength ? `maxlength="${escapeHtml(normalizedInput.maxLength)}"` : ''}
                        ${normalizedInput.autofocus ? 'data-dialog-style-1-input-autofocus="true"' : ''}
                    />
                </label>` : ''}
                ${note ? `<p class="dialog-style-1-note" data-dialog-style-1-note="true">${escapeHtml(note)}</p>` : ''}
            </div>
            <div class="dialog-style-1-footer">
                ${actionButtons}
            </div>
        </div>
    `;

    dialog.classList.remove('hidden');

    return new Promise((resolve) => {
        const inputTarget = dialog.querySelector('[data-dialog-style-1-input="true"]');
        dialogState.set(id, {
            resolve,
            getValue: normalizedInput
                ? () => inputTarget?.value ?? ''
                : null
        });
        if (inputTarget && normalizedInput?.rejectPattern) {
            const noteTarget = dialog.querySelector('[data-dialog-style-1-note="true"]');
            const showRejectFeedback = createRejectFeedback([inputTarget, noteTarget], normalizedInput.onReject);
            let lastAcceptedValue = sanitizeInputValue(inputTarget.value, normalizedInput.rejectPattern);
            if (lastAcceptedValue !== inputTarget.value) inputTarget.value = lastAcceptedValue;
            inputTarget.addEventListener('beforeinput', (event) => {
                if (!event.inputType?.startsWith('insert')) return;
                const nextValue = getNextInputValue(inputTarget, event.data ?? '');
                if (!hasRejectedInput(nextValue, normalizedInput.rejectPattern)) return;
                event.preventDefault();
                showRejectFeedback();
            });
            inputTarget.addEventListener('input', () => {
                const cleanValue = sanitizeInputValue(inputTarget.value, normalizedInput.rejectPattern);
                if (cleanValue !== inputTarget.value) {
                    inputTarget.value = cleanValue;
                    showRejectFeedback();
                }
                lastAcceptedValue = inputTarget.value;
            });
            inputTarget.addEventListener('paste', (event) => {
                const text = event.clipboardData?.getData('text') ?? '';
                if (!hasRejectedInput(text, normalizedInput.rejectPattern)) return;
                event.preventDefault();
                const cleanText = sanitizeInputValue(text, normalizedInput.rejectPattern);
                insertTextIntoInput(inputTarget, cleanText);
                showRejectFeedback();
            });
            inputTarget.addEventListener('drop', (event) => {
                const text = event.dataTransfer?.getData('text') ?? '';
                if (!hasRejectedInput(text, normalizedInput.rejectPattern)) return;
                event.preventDefault();
                const cleanText = sanitizeInputValue(text, normalizedInput.rejectPattern);
                insertTextIntoInput(inputTarget, cleanText);
                lastAcceptedValue = inputTarget.value;
                showRejectFeedback();
            });
            inputTarget.addEventListener('compositionend', () => {
                const cleanValue = sanitizeInputValue(inputTarget.value, normalizedInput.rejectPattern);
                if (cleanValue !== inputTarget.value) {
                    inputTarget.value = cleanValue;
                    showRejectFeedback();
                }
                lastAcceptedValue = inputTarget.value;
            });
            inputTarget.addEventListener('change', () => {
                if (!hasRejectedInput(inputTarget.value, normalizedInput.rejectPattern)) {
                    lastAcceptedValue = inputTarget.value;
                    return;
                }
                inputTarget.value = lastAcceptedValue;
                showRejectFeedback();
            });
        }
        dialog.onkeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                resolveDialog({ id, documentRef, actionId: cancelActionId });
            } else if (
                event.key === 'Enter'
                && normalizedInput
                && event.target?.matches?.('[data-dialog-style-1-input="true"]')
                && !event.isComposing
            ) {
                event.preventDefault();
                resolveDialog({ id, documentRef, actionId: submitActionId });
            }
        };
        dialog.onclick = (event) => {
            const button = event.target.closest('[data-dialog-style-1-action]');
            if (!button) return;
            event.preventDefault();
            resolveDialog({
                id,
                documentRef,
                actionId: button.getAttribute('data-dialog-style-1-action') || cancelActionId
            });
        };

        const autofocusInput = dialog.querySelector('[data-dialog-style-1-input-autofocus="true"]');
        const focusTarget = autofocusInput
            || dialog.querySelector('[data-dialog-style-1-autofocus="true"]')
            || dialog.querySelector('[data-dialog-style-1-action]');
        focusTarget?.focus();
        if (autofocusInput && typeof autofocusInput.select === 'function') {
            autofocusInput.select();
        }
    });
}
