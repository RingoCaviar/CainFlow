import { openDialogStyle1 } from './dialog-style-1.js';

const pendingDocuments = new WeakSet();

async function requestDecision({ documentRef = document, title, message = '', note = '',
    confirmLabel = '确定', danger = false, input = null, signal = null }) {
    // A second trigger must not replace the first decision or execute it twice.
    if (pendingDocuments.has(documentRef)) return 'cancel';
    pendingDocuments.add(documentRef);
    try {
        return await openDialogStyle1({
            id: 'app-action-dialog', documentRef, title, message, note, input, signal,
            actions: [
                { id: 'cancel', label: '取消', variant: 'secondary', autofocus: danger },
                { id: 'confirm', label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: !danger }
            ]
        });
    } finally {
        pendingDocuments.delete(documentRef);
    }
}

export async function confirmAction(options) {
    return await requestDecision(options) === 'confirm';
}

export async function promptInput({ value = '', message = '', ...options }) {
    const result = await requestDecision({ ...options, input: { value, label: message || options.title } });
    return result?.actionId === 'confirm' ? result.value : null;
}
