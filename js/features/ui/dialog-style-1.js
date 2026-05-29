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
    dialog.classList.add('hidden');
    dialog.onkeydown = null;
    dialog.onclick = null;
    dialog.innerHTML = '';

    const state = dialogState.get(id);
    dialogState.delete(id);
    state?.resolve?.(actionId);
}

export function openDialogStyle1({
    id = 'dialog-style-1',
    title = '',
    message = '',
    note = '',
    actions,
    cancelActionId = 'cancel',
    labelledBy = `${id}-title`,
    documentRef = document
} = {}) {
    if (dialogState.has(id)) {
        resolveDialog({ id, documentRef, actionId: cancelActionId });
    }

    const dialog = getDialogElement({ id, documentRef });
    const normalizedActions = normalizeActions(actions);
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
                ${note ? `<p class="dialog-style-1-note">${escapeHtml(note)}</p>` : ''}
            </div>
            <div class="dialog-style-1-footer">
                ${actionButtons}
            </div>
        </div>
    `;

    dialog.classList.remove('hidden');

    return new Promise((resolve) => {
        dialogState.set(id, { resolve });
        dialog.onkeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                resolveDialog({ id, documentRef, actionId: cancelActionId });
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

        const focusTarget = dialog.querySelector('[data-dialog-style-1-autofocus="true"]')
            || dialog.querySelector('[data-dialog-style-1-action]');
        focusTarget?.focus();
    });
}
