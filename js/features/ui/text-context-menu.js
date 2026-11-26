import { getSurfaceCoordinator } from './surface-coordinator.js';

const textControls = 'input, textarea';
const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'number', 'password']);
const editableRegion = '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
const popoverId = 'text-context';

export function installTextContextMenu({ documentRef = document, windowRef = window, showToast, onNativeClipboardWrite }) {
    const surfaces = getSurfaceCoordinator(documentRef);
    let menu;
    let focusedItem = -1;

    function close() {
        if (!menu) return;
        surfaces?.forgetPopover(popoverId);
        menu.remove();
        menu = null;
        focusedItem = -1;
    }

    function selectedPageText(target) {
        const selection = windowRef.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed || target === documentRef.body) return '';
        return selection.getRangeAt(0).intersectsNode(target) ? selection.toString() : '';
    }

    function selectedEditorText(editor) {
        if (!editor.matches(textControls)) return selectedPageText(editor);
        if (editor.type === 'password') return '';
        return editor.selectionStart === null ? editor.value : editor.value.slice(editor.selectionStart, editor.selectionEnd);
    }

    async function run(command, editor, text) {
        close();
        if (editor?.closest('[inert]') || (editor && !editor.isConnected)) return;
        editor?.focus({ preventScroll: true });
        if (command === 'selectAll') {
            if (editor.matches(textControls)) editor.select();
            else windowRef.getSelection().selectAllChildren(editor);
            return;
        }

        const selection = windowRef.getSelection();
        const readEditState = () => editor.matches(textControls)
            ? [editor.value, editor.selectionStart, editor.selectionEnd]
            : [editor.innerHTML, selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
        const edits = command === 'cut' || command === 'paste';
        const before = edits ? readEditState() : [];
        const canEdit = () => editor.isConnected && !editor.closest('[inert]') && !editor.matches(':disabled, [readonly]')
            && editor.contains(documentRef.activeElement) && readEditState().every((part, index) => part === before[index]);
        if (command === 'cut' && selectedEditorText(editor) !== text) return;
        try {
            const clipboard = windowRef.navigator.clipboard;
            if (command === 'paste') {
                const pasted = await clipboard.readText();
                if (pasted && canEdit() && !documentRef.execCommand('insertText', false, pasted)) {
                    showToast('无法粘贴文字，请使用 Ctrl+V', 'error');
                }
            } else {
                await clipboard.writeText(text);
                onNativeClipboardWrite?.();
                if (command === 'cut' && canEdit()) documentRef.execCommand('delete');
            }
        } catch {
            showToast(command === 'paste' ? '无法读取剪贴板，请使用 Ctrl+V' : '无法写入剪贴板', 'error');
        }
    }

    function open(event, keyboard = false) {
        if (event.defaultPrevented) return;
        const target = event.target;
        if (!target?.closest || target.closest('[inert], button, img, video, canvas, select')) return;
        const control = target.closest(textControls);
        if (control && (control.matches(':disabled') || (control.tagName === 'INPUT' && !textInputTypes.has(control.type)))) return;
        const editor = control || (target.isContentEditable ? target.closest(editableRegion) : null);
        const password = control?.type === 'password';
        const writable = editor && !control?.readOnly;
        if (editor && documentRef.activeElement !== editor) editor.focus({ preventScroll: true });
        const hasOffsets = control && control.selectionStart !== null;
        const text = editor ? selectedEditorText(editor) : selectedPageText(target);
        if (!editor && !text) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        menu = documentRef.createElement('div');
        menu.className = 'context-menu text-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '文字编辑');
        const add = (command, label, disabled = false) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'context-menu-item';
            button.tabIndex = -1;
            button.setAttribute('role', 'menuitem');
            button.textContent = label;
            button.disabled = disabled;
            button.addEventListener('click', () => void run(command, editor, text));
            menu.append(button);
        };
        if (writable && !password && (!control || hasOffsets)) add('cut', '剪切', !text);
        if (!password) add('copy', '复制', !text);
        if (writable) add('paste', '粘贴');
        if (editor) add('selectAll', '全选');

        const origin = target.getBoundingClientRect();
        const fromKeyboard = keyboard || (event.clientX === 0 && event.clientY === 0);
        const x = fromKeyboard ? origin.left : event.clientX;
        const y = fromKeyboard ? origin.bottom : event.clientY;
        menu.style.left = '0px';
        menu.style.top = '0px';
        menu.addEventListener('pointerdown', event => event.preventDefault());
        documentRef.body.append(menu);
        surfaces?.openPopover(popoverId, { element: menu, trigger: editor || target, close });
        if (!menu) return;
        menu.style.left = `${Math.max(8, Math.min(x, windowRef.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, windowRef.innerHeight - menu.offsetHeight - 8))}px`;
        if (fromKeyboard) moveFocus(0);
    }

    function moveFocus(index) {
        const items = [...menu.querySelectorAll('button:not(:disabled)')];
        if (!items.length) return;
        focusedItem = (index + items.length) % items.length;
        items.forEach((item, itemIndex) => item.classList.toggle('is-focused', itemIndex === focusedItem));
        items[focusedItem].scrollIntoView({ block: 'nearest' });
    }

    documentRef.addEventListener('contextmenu', event => open(event), true);
    windowRef.addEventListener('pointerdown', event => {
        if (menu && !menu.contains(event.target)) close();
    }, true);
    windowRef.addEventListener('blur', close);
    windowRef.addEventListener('resize', close);
    windowRef.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            open(event, true);
            return;
        }
        if (!menu) return;
        const items = menu.querySelectorAll('button:not(:disabled)');
        if (event.key === 'ArrowDown') moveFocus(focusedItem + 1);
        else if (event.key === 'ArrowUp') moveFocus(focusedItem < 0 ? -1 : focusedItem - 1);
        else if (event.key === 'Home') moveFocus(0);
        else if (event.key === 'End') moveFocus(-1);
        else if ((event.key === 'Enter' || event.key === ' ') && focusedItem >= 0) items[focusedItem]?.click();
        else if (event.key === 'Escape') close();
        else {
            close();
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
}
