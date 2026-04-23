/**
 * 负责历史记录列表的加载、渲染、网格布局调整与批量展示入口。
 */
export function createHistoryPanelApi({
    state,
    getHistory,
    createThumbnail,
    openDB,
    openHistoryPreview,
    deleteHistoryEntry,
    storeHistoryName = 'imageHistory'
}) {
    function applyHistoryGridCols(cols) {
        let normalized = cols;
        if (normalized < 2) normalized = 2;
        if (normalized > 5) normalized = 5;
        state.historyGridCols = normalized;
        const sidebar = document.getElementById('history-sidebar');
        const label = document.getElementById('history-grid-cols-label');
        if (sidebar) sidebar.style.setProperty('--history-grid-cols', normalized);
        if (label) label.textContent = normalized;
    }

    async function renderHistoryList() {
        const list = document.getElementById('history-list');
        const items = await getHistory();
        if (!list) return;

        const countBadge = document.getElementById('history-total-count');
        if (!items.length) {
            list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 40px 0; font-size:13px;">暂无历史记录</div>';
            if (countBadge) countBadge.textContent = '';
            return;
        }
        if (countBadge) countBadge.textContent = `共 ${items.length} 张`;

        const displayItems = items.slice(0, 100);
        const hasMore = items.length > 100;

        let html = displayItems.map((item) => {
            const isSelected = state.selectedHistoryIds.has(item.id);
            const modeClass = state.historySelectionMode ? 'multi-select-mode' : '';
            const selectedClass = isSelected ? 'selected' : '';

            if (!item.thumb && item.image) {
                setTimeout(async () => {
                    const thumb = await createThumbnail(item.image);
                    const db = await openDB();
                    const tx = db.transaction(storeHistoryName, 'readwrite');
                    tx.objectStore(storeHistoryName).put({ ...item, thumb });
                }, 0);
            }

            return `
                <div class="history-card ${modeClass} ${selectedClass}" data-id="${item.id}">
                    <img src="${item.thumb || item.image}" loading="lazy" decoding="async" />
                    <div class="selection-checkbox"></div>
                    <button class="delete-btn" data-id="${item.id}" title="删除记录">×</button>
                </div>
            `;
        }).join('');

        if (hasMore) {
            html += `<div style="grid-column: 1/-1; color:var(--text-dim); text-align:center; padding: 20px; font-size:12px;">已显示最近 100 条记录（共 ${items.length} 条）</div>`;
        }

        list.innerHTML = html;

        const countEl = document.getElementById('selected-count');
        if (countEl) countEl.textContent = state.selectedHistoryIds.size;

        list.querySelectorAll('.history-card').forEach((card) => {
            card.addEventListener('click', () => {
                const itemId = Number(card.dataset.id);
                const item = items.find((entry) => entry.id === itemId);

                if (state.historySelectionMode) {
                    if (state.selectedHistoryIds.has(itemId)) state.selectedHistoryIds.delete(itemId);
                    else state.selectedHistoryIds.add(itemId);
                    renderHistoryList();
                } else if (item) {
                    openHistoryPreview(item);
                }
            });
        });

        list.querySelectorAll('.delete-btn').forEach((button) => {
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (!confirm('确定要删除这条历史记录吗？')) return;
                await deleteHistoryEntry(Number(button.dataset.id));
                renderHistoryList();
            });
        });
    }

    return {
        applyHistoryGridCols,
        renderHistoryList
    };
}
/**
 * 管理历史记录面板的渲染、选择和删除交互。
 */
