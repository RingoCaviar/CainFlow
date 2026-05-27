import { buildHistoryCardMarkup } from './history-utils.js';

/**
 * 管理轻量级历史侧栏。
 */
export function createHistoryPanelApi({
    state,
    getHistory,
    getHistoryMetadata = getHistory,
    getHistoryCount = async () => (await getHistoryMetadata()).length,
    getHistoryEntry = async (id) => (await getHistory()).find((entry) => entry.id === id) || null,
    createThumbnail,
    updateHistoryThumb = null,
    openHistoryPreview,
    deleteHistoryEntry,
    documentRef = document,
    windowRef = window
}) {
    const SIDEBAR_LIMIT = 100;
    let renderToken = 0;

    function applyHistoryGridCols(cols) {
        let normalized = Number(cols) || 2;
        if (normalized < 2) normalized = 2;
        if (normalized > 5) normalized = 5;
        state.historyGridCols = normalized;
        const sidebar = documentRef.getElementById('history-sidebar');
        const label = documentRef.getElementById('history-grid-cols-label');
        if (sidebar) sidebar.style.setProperty('--history-grid-cols', normalized);
        if (label) label.textContent = normalized;
    }

    async function hydrateHistoryItem(itemId) {
        const entry = await getHistoryEntry(Number(itemId));
        return entry || null;
    }

    function queueThumbHydration(items, token) {
        const missing = items.filter((item) => !item.thumb && item.hasImage);
        if (!missing.length) return;

        const run = windowRef.requestIdleCallback || ((callback) => setTimeout(() => callback({ timeRemaining: () => 16 }), 16));
        let index = 0;

        const process = async (deadline) => {
            while (index < missing.length && token === renderToken && deadline.timeRemaining() > 4) {
                const item = missing[index++];
                try {
                    const entry = await hydrateHistoryItem(item.id);
                    if (!entry?.image) continue;
                    const thumb = await createThumbnail(entry.image);
                    if (updateHistoryThumb) await updateHistoryThumb(item.id, thumb, entry);
                    const img = documentRef.querySelector(`#history-list .history-card[data-id="${item.id}"] img`);
                    if (img && token === renderToken) {
                        img.src = thumb;
                        img.classList.remove('history-card-img-pending');
                    }
                } catch (error) {
                    console.warn('Hydrate history thumbnail failed:', error);
                }
            }

            if (index < missing.length && token === renderToken) {
                run(process);
            }
        };

        run(process);
    }

    function updateSelectedCount() {
        const countEl = documentRef.getElementById('selected-count');
        if (countEl) countEl.textContent = state.selectedHistoryIds.size;
    }

    function bindHistoryListEvents(list, itemsById) {
        list.querySelectorAll('.history-card').forEach((card) => {
            card.draggable = card.dataset.mediaType !== 'video';
        });

        list.ondragstart = (event) => {
            const card = event.target.closest('.history-card');
            if (!card) return;
            if (card.dataset.mediaType === 'video') {
                event.preventDefault();
                return;
            }

            const itemId = Number(card.dataset.id);
            const imagePromise = hydrateHistoryItem(itemId).then((item) => item?.image || '');
            state.draggedHistoryImage = { id: itemId, image: null, imagePromise };
            imagePromise.then((image) => {
                if (state.draggedHistoryImage?.id === itemId) state.draggedHistoryImage.image = image;
            });
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-cainflow-history-image', String(itemId));
        };

        list.ondragend = () => {
            setTimeout(() => {
                state.draggedHistoryImage = null;
            }, 0);
        };

        list.onclick = async (event) => {
            const deleteButton = event.target.closest('.delete-btn');
            if (deleteButton) {
                event.stopPropagation();
                if (!confirm('确定要删除这条历史记录吗？')) return;
                await deleteHistoryEntry(Number(deleteButton.dataset.id));
                renderHistoryList();
                return;
            }

            const card = event.target.closest('.history-card');
            if (!card) return;
            const itemId = Number(card.dataset.id);

            if (state.historySelectionMode) {
                if (state.selectedHistoryIds.has(itemId)) state.selectedHistoryIds.delete(itemId);
                else state.selectedHistoryIds.add(itemId);
                const metadata = itemsById.get(itemId);
                if (metadata) {
                    card.classList.toggle('selected', state.selectedHistoryIds.has(itemId));
                } else {
                    renderHistoryList();
                }
                updateSelectedCount();
                return;
            }

            const item = await hydrateHistoryItem(itemId);
            if (item) openHistoryPreview(item);
        };
    }

    async function renderHistoryList() {
        const token = ++renderToken;
        const list = documentRef.getElementById('history-list');
        const countBadge = documentRef.getElementById('history-total-count');
        const [items, totalCount] = await Promise.all([
            getHistoryMetadata({ limit: SIDEBAR_LIMIT, preserveCursorOrder: true }),
            getHistoryCount()
        ]);
        if (token !== renderToken) return;
        if (!list) return;

        if (!items.length) {
            list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 40px 0; font-size:13px;">暂无历史记录</div>';
            if (countBadge) countBadge.textContent = '';
            return;
        }

        if (countBadge) countBadge.textContent = `共 ${totalCount} 条`;

        const displayItems = items;
        const hasMore = totalCount > SIDEBAR_LIMIT;
        const itemsById = new Map(displayItems.map((item) => [item.id, item]));

        let html = displayItems.map((item) => buildHistoryCardMarkup({
            item,
            selected: state.selectedHistoryIds.has(item.id),
            multiSelectMode: state.historySelectionMode,
            compact: true
        })).join('');

        if (hasMore) {
            html += `<div style="grid-column: 1/-1; color:var(--text-dim); text-align:center; padding: 20px; font-size:12px;">侧栏仅显示最近 ${SIDEBAR_LIMIT} 条记录，完整历史请使用全屏历史面板查看。</div>`;
        }

        list.innerHTML = html;
        updateSelectedCount();
        bindHistoryListEvents(list, itemsById);
        queueThumbHydration(displayItems, token);
    }

    return {
        applyHistoryGridCols,
        renderHistoryList
    };
}
