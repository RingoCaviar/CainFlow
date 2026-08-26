export function reorderItemsById(items, orderedIds) {
    const itemById = new Map(items.map((item) => [item.id, item]));
    const reordered = orderedIds.map((id) => itemById.get(id)).filter(Boolean);
    const includedIds = new Set(reordered.map((item) => item.id));
    items.forEach((item) => {
        if (!includedIds.has(item.id)) reordered.push(item);
    });
    return reordered;
}

export function toggleOrderedId(orderedIds, id) {
    return orderedIds.includes(id)
        ? orderedIds.filter((candidate) => candidate !== id)
        : [...orderedIds, id];
}

function findScrollableAncestor(element, windowRef) {
    let current = element?.parentElement || null;
    while (current) {
        const style = windowRef.getComputedStyle?.(current);
        const overflowY = style?.overflowY || '';
        if (/(auto|scroll)/.test(overflowY) && current.scrollHeight > current.clientHeight) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

export function bindSettingsCardOrder({
    list,
    cardSelector,
    idAttribute,
    documentRef,
    windowRef,
    onCommit
}) {
    let draggedCard = null;
    let originalIds = [];
    let cancelled = false;
    let scrollContainer = null;

    const getCards = () => Array.from(list.querySelectorAll(cardSelector));
    const getCardId = (card) => card.dataset[idAttribute] || '';
    const restoreOriginalOrder = () => {
        const cardsById = new Map(getCards().map((card) => [getCardId(card), card]));
        originalIds.forEach((id) => {
            const card = cardsById.get(id);
            if (card) list.appendChild(card);
        });
    };
    const clearDragState = () => {
        draggedCard?.classList.remove('is-dragging');
        draggedCard?.classList.remove('is-drag-cancelled');
        getCards().forEach((card) => card.classList.remove('is-drag-target'));
        documentRef.removeEventListener('keydown', handleKeydown);
        list.classList.remove('is-card-sorting');
        draggedCard = null;
        originalIds = [];
        cancelled = false;
        scrollContainer = null;
    };
    const finishDrag = () => {
        if (!draggedCard) return;
        if (cancelled) restoreOriginalOrder();
        const orderedIds = getCards().map(getCardId);
        const changed = !cancelled && orderedIds.some((id, index) => id !== originalIds[index]);
        clearDragState();
        if (changed) onCommit(orderedIds);
    };
    function handleKeydown(event) {
        if (event.key !== 'Escape' || !draggedCard) return;
        event.preventDefault();
        cancelled = true;
        restoreOriginalOrder();
        draggedCard.classList.add('is-drag-cancelled');
    }
    const autoScroll = (clientY) => {
        if (!scrollContainer) return;
        const rect = scrollContainer.getBoundingClientRect();
        const edgeSize = Math.min(56, rect.height / 4);
        if (clientY < rect.top + edgeSize) scrollContainer.scrollTop -= 14;
        else if (clientY > rect.bottom - edgeSize) scrollContainer.scrollTop += 14;
    };

    getCards().forEach((card) => {
        const handle = card.querySelector('.card-drag-handle');
        if (!handle) return;
        handle.addEventListener('dragstart', (event) => {
            draggedCard = card;
            originalIds = getCards().map(getCardId);
            cancelled = false;
            scrollContainer = findScrollableAncestor(list, windowRef);
            list.classList.add('is-card-sorting');
            card.classList.add('is-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', getCardId(card));
            documentRef.addEventListener('keydown', handleKeydown);
        });
        handle.addEventListener('dragend', finishDrag);

        card.addEventListener('dragover', (event) => {
            if (!draggedCard || draggedCard === card || cancelled) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            autoScroll(event.clientY);
            const rect = card.getBoundingClientRect();
            const insertBefore = event.clientY < rect.top + rect.height / 2;
            const reference = insertBefore ? card : card.nextSibling;
            if (reference !== draggedCard) list.insertBefore(draggedCard, reference);
            getCards().forEach((candidate) => candidate.classList.remove('is-drag-target'));
            card.classList.add('is-drag-target');
        });
        card.addEventListener('drop', (event) => {
            if (!draggedCard) return;
            event.preventDefault();
            finishDrag();
        });
    });
}
