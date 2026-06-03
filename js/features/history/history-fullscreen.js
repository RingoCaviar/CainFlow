import {
    buildHistoryCardMarkup,
    escapeHistoryHtml,
    groupHistoryItems
} from './history-utils.js';

const CARD_MIN_WIDTH = 230;
const CARD_GAP = 12;
const GROUP_HEADER_HEIGHT = 56;
const VIRTUAL_OVERSCAN = 900;

/**
 * 面向超大量历史记录的全屏浏览面板。
 */
export function createHistoryFullscreenApi({
    state,
    getHistory,
    getHistoryMetadata = async () => [],
    getHistoryEntry = async (id) => (await getHistory()).find((entry) => entry.id === id) || null,
    clearHistory,
    deleteHistoryEntry,
    deleteHistoryItems,
    openHistoryPreview,
    downloadImage,
    createThumbnail = null,
    updateHistoryThumb = null,
    showToast,
    documentRef = document,
    windowRef = window,
    confirmRef = confirm
}) {
    const viewState = {
        items: [],
        itemMap: new Map(),
        groups: [],
        rows: [],
        activeGroupId: null,
        scrollHandlerBound: false,
        cardEventsBound: false,
        renderFrame: 0,
        renderedRangeKey: '',
        renderedRows: new Map(),
        thumbQueue: [],
        queuedThumbIds: new Set(),
        hydratingThumbs: false,
        version: 0,
        layout: {
            width: 0,
            columns: 1,
            cardHeight: 272,
            totalHeight: 0
        }
    };
    let modalObserver = null;

    function getEls() {
        return {
            modal: documentRef.getElementById('history-fullscreen-modal'),
            scroll: documentRef.getElementById('history-fullscreen-scroll'),
            list: documentRef.getElementById('history-fullscreen-list'),
            timeline: documentRef.getElementById('history-fullscreen-timeline'),
            tooltip: documentRef.getElementById('history-fullscreen-rail-tooltip'),
            count: documentRef.getElementById('history-fullscreen-count'),
            summary: documentRef.getElementById('history-fullscreen-summary'),
            batchToolbar: documentRef.getElementById('history-fullscreen-batch-toolbar'),
            selectedCount: documentRef.getElementById('history-fullscreen-selected-count')
        };
    }

    function syncSelectionCount() {
        const { selectedCount } = getEls();
        if (selectedCount) selectedCount.textContent = String(state.selectedHistoryIds.size);
    }

    function renderEmptyState() {
        const { list, timeline, count, summary } = getEls();
        viewState.rows = [];
        viewState.renderedRangeKey = '';
        if (count) count.textContent = '0';
        if (summary) summary.textContent = '按大概时间分组浏览历史记录';
        if (list) {
            list.classList.remove('history-fullscreen-list-virtual');
            list.style.height = '';
            viewState.renderedRows.clear();
            list.innerHTML = '<div class="history-fullscreen-empty">暂无历史记录</div>';
        }
        if (timeline) timeline.innerHTML = '';
    }

    function getLayoutMetrics() {
        const { list, scroll } = getEls();
        const width = Math.max(280, list?.clientWidth || scroll?.clientWidth || 960);
        const columns = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
        const cardWidth = (width - ((columns - 1) * CARD_GAP)) / columns;
        return {
            width,
            columns,
            cardHeight: Math.max(220, Math.round(cardWidth * 1.18))
        };
    }

    function buildVirtualRows() {
        const layout = getLayoutMetrics();
        const rows = [];
        let top = 0;

        viewState.groups.forEach((group) => {
            rows.push({
                id: `${group.id}:header`,
                type: 'header',
                group,
                top,
                height: GROUP_HEADER_HEIGHT
            });
            top += GROUP_HEADER_HEIGHT;

            for (let index = 0; index < group.items.length; index += layout.columns) {
                rows.push({
                    id: `${group.id}:cards:${index}`,
                    type: 'cards',
                    group,
                    items: group.items.slice(index, index + layout.columns),
                    top,
                    height: layout.cardHeight
                });
                top += layout.cardHeight + CARD_GAP;
            }
        });

        viewState.rows = rows;
        viewState.layout = {
            ...layout,
            totalHeight: Math.max(0, top)
        };
        viewState.renderedRangeKey = '';
    }

    function renderTimeline(groups) {
        const { timeline } = getEls();
        if (!timeline) return;

        timeline.innerHTML = groups.map((group) => `
            <button class="history-timeline-marker ${viewState.activeGroupId === group.id ? 'active' : ''}"
                type="button"
                data-group-id="${group.id}"
                data-label="${escapeHistoryHtml(group.label)}">
                <span class="history-timeline-marker-line"></span>
                <span class="history-timeline-marker-dot"></span>
            </button>
        `).join('');

        timeline.querySelectorAll('.history-timeline-marker').forEach((button) => {
            button.addEventListener('mouseenter', () => showTimelineTooltip(button));
            button.addEventListener('focus', () => showTimelineTooltip(button));
            button.addEventListener('mouseleave', hideTimelineTooltip);
            button.addEventListener('blur', hideTimelineTooltip);
            button.addEventListener('click', () => jumpToGroup(button.dataset.groupId));
        });
    }

    function renderVirtualRow(row) {
        if (row.type === 'header') {
            return `
                <section class="history-fullscreen-virtual-row history-fullscreen-virtual-header-row"
                    id="${row.group.id}"
                    data-group-id="${row.group.id}"
                    style="top:${row.top}px;height:${row.height}px;">
                    <header class="history-fullscreen-group-header">
                        <div class="history-fullscreen-group-title">
                            <h3>${escapeHistoryHtml(row.group.label)}</h3>
                            <span>${row.group.items.length} 条</span>
                        </div>
                    </header>
                </section>
            `;
        }

        return `
            <div class="history-fullscreen-virtual-row history-fullscreen-virtual-card-row"
                data-group-id="${row.group.id}"
                style="top:${row.top}px;height:${row.height}px;--history-virtual-cols:${viewState.layout.columns};">
                ${row.items.map((item) => buildHistoryCardMarkup({
                    item,
                    selected: state.selectedHistoryIds.has(item.id),
                    multiSelectMode: state.historySelectionMode,
                    compact: false
                })).join('')}
            </div>
        `;
    }

    function clearRenderedRows(list) {
        viewState.renderedRows.clear();
        viewState.renderedRangeKey = '';
        if (list) list.replaceChildren();
    }

    function releaseViewState() {
        viewState.items = [];
        viewState.itemMap = new Map();
        viewState.groups = [];
        viewState.rows = [];
        viewState.activeGroupId = null;
        viewState.thumbQueue = [];
        viewState.queuedThumbIds.clear();
        viewState.hydratingThumbs = false;
        viewState.renderedRangeKey = '';
        if (viewState.renderFrame) {
            windowRef.cancelAnimationFrame(viewState.renderFrame);
            viewState.renderFrame = 0;
        }
    }

    function ensureModalObserver() {
        if (modalObserver || typeof MutationObserver !== 'function') return;
        const { modal, list, timeline, count, summary } = getEls();
        if (!modal) return;
        modalObserver = new MutationObserver(() => {
            if (!modal.classList.contains('hidden')) return;
            if (viewState.items.length === 0 && viewState.thumbQueue.length === 0) return;
            viewState.version += 1;
            if (list) {
                clearRenderedRows(list);
                list.style.height = '';
            }
            if (timeline) timeline.innerHTML = '';
            if (count) count.textContent = '0';
            if (summary) summary.textContent = '按大概时间分组浏览历史记录';
            releaseViewState();
        });
        modalObserver.observe(modal, {
            attributes: true,
            attributeFilter: ['class']
        });
    }

    function createVirtualRowElement(row) {
        const template = documentRef.createElement('template');
        template.innerHTML = renderVirtualRow(row).trim();
        return template.content.firstElementChild;
    }

    function getVisibleRows(scrollTop, viewportHeight) {
        const start = Math.max(0, scrollTop - VIRTUAL_OVERSCAN);
        const end = scrollTop + viewportHeight + VIRTUAL_OVERSCAN;
        return viewState.rows.filter((row) => row.top + row.height >= start && row.top <= end);
    }

    function renderVirtualWindow({ force = false } = {}) {
        const { scroll, list } = getEls();
        if (!scroll || !list || !viewState.items.length) return;

        const currentWidth = Math.max(280, list.clientWidth || scroll.clientWidth || 960);
        if (Math.abs(currentWidth - viewState.layout.width) > 2) {
            buildVirtualRows();
            force = true;
        }

        const visibleRows = getVisibleRows(scroll.scrollTop, scroll.clientHeight || 800);
        const rangeKey = visibleRows.map((row) => row.id).join('|');
        if (!force && rangeKey === viewState.renderedRangeKey) return;

        list.classList.add('history-fullscreen-list-virtual');
        list.style.height = `${viewState.layout.totalHeight}px`;

        if (force) {
            clearRenderedRows(list);
        }

        const visibleIds = new Set(visibleRows.map((row) => row.id));
        viewState.renderedRows.forEach((rowEl, rowId) => {
            if (!visibleIds.has(rowId)) {
                rowEl.remove();
                viewState.renderedRows.delete(rowId);
            }
        });

        visibleRows.forEach((row) => {
            let rowEl = viewState.renderedRows.get(row.id);
            if (!rowEl) {
                rowEl = createVirtualRowElement(row);
                if (!rowEl) return;
                viewState.renderedRows.set(row.id, rowEl);
                list.appendChild(rowEl);
                return;
            }
            if (rowEl.parentNode !== list) list.appendChild(rowEl);
        });

        viewState.renderedRangeKey = rangeKey;
        queueVisibleThumbHydration(visibleRows);
    }

    function renderGroups() {
        const { list, count, summary } = getEls();
        if (!list) return;
        if (!viewState.items.length) {
            renderEmptyState();
            return;
        }

        if (count) count.textContent = String(viewState.items.length);
        if (summary) summary.textContent = `按大概时间分组浏览 ${viewState.items.length} 条历史记录`;

        buildVirtualRows();
        renderTimeline(viewState.groups);
        renderVirtualWindow({ force: true });
        updateActiveGroupFromScroll();
    }

    function queueVisibleThumbHydration(rows) {
        if (!createThumbnail || !updateHistoryThumb) return;
        rows
            .filter((row) => row.type === 'cards')
            .flatMap((row) => row.items)
            .filter((item) => item.hasImage && !item.thumb && !viewState.queuedThumbIds.has(item.id))
            .forEach((item) => {
                viewState.queuedThumbIds.add(item.id);
                viewState.thumbQueue.push(item);
            });

        if (!viewState.hydratingThumbs && viewState.thumbQueue.length) {
            viewState.hydratingThumbs = true;
            setTimeout(processThumbQueue, 16);
        }
    }

    async function processThumbQueue() {
        const version = viewState.version;
        const item = viewState.thumbQueue.shift();
        if (!item) {
            if (version === viewState.version) {
                viewState.hydratingThumbs = false;
            }
            return;
        }

        try {
            const entry = await getHistoryEntry(item.id);
            if (version !== viewState.version) return;
            if (entry?.image) {
                const thumb = entry.thumb || await createThumbnail(entry.image);
                if (version !== viewState.version) return;
                if (!entry.thumb) await updateHistoryThumb(item.id, thumb, entry);
                if (version !== viewState.version) return;
                item.thumb = thumb;
                viewState.itemMap.set(item.id, item);
                const img = documentRef.querySelector(`#history-fullscreen-list .history-card[data-id="${item.id}"] img`);
                if (img) {
                    img.src = thumb;
                    img.classList.remove('history-card-img-pending');
                }
            }
        } catch (error) {
            console.warn('Hydrate fullscreen history thumbnail failed:', error);
        } finally {
            if (version !== viewState.version) {
                viewState.hydratingThumbs = false;
                return;
            }
            setTimeout(processThumbQueue, 16);
        }
    }

    function bindCardEvents() {
        const { list } = getEls();
        if (!list || viewState.cardEventsBound) return;

        list.addEventListener('click', async (event) => {
            const deleteButton = event.target.closest('.delete-btn');
            if (deleteButton) {
                event.stopPropagation();
                const id = Number(deleteButton.dataset.id);
                if (!confirmRef('确定要删除这条历史记录吗？')) return;
                await deleteHistoryEntry(id);
                await refresh();
                return;
            }

            const card = event.target.closest('.history-card');
            if (!card) return;
            const itemId = Number(card.dataset.id);
            const item = viewState.itemMap.get(itemId);
            if (!item) return;

            if (state.historySelectionMode) {
                if (state.selectedHistoryIds.has(itemId)) state.selectedHistoryIds.delete(itemId);
                else state.selectedHistoryIds.add(itemId);
                card.classList.toggle('selected', state.selectedHistoryIds.has(itemId));
                syncSelectionCount();
            } else {
                openHistoryPreview(item, { fromFullscreen: true });
            }
        });

        list.addEventListener('dragstart', (event) => {
            const card = event.target.closest('.history-card');
            if (!card) return;
            if (card.dataset.mediaType === 'video') {
                event.preventDefault();
                return;
            }
            const itemId = Number(card.dataset.id);
            const imagePromise = getHistoryEntry(itemId).then((entry) => entry?.image || '');
            state.draggedHistoryImage = { id: itemId, image: null, imagePromise };
            imagePromise.then((image) => {
                if (state.draggedHistoryImage?.id === itemId) state.draggedHistoryImage.image = image;
            });
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-cainflow-history-image', String(itemId));
        });

        list.addEventListener('dragend', () => {
            setTimeout(() => {
                state.draggedHistoryImage = null;
            }, 0);
        });

        viewState.cardEventsBound = true;
    }

    async function refresh() {
        const version = ++viewState.version;
        viewState.thumbQueue = [];
        viewState.queuedThumbIds.clear();
        viewState.items = await getHistoryMetadata({ includeThumbs: false });
        if (version !== viewState.version) return;
        viewState.itemMap = new Map(viewState.items.map((item) => [item.id, item]));
        viewState.groups = groupHistoryItems(viewState.items);
        if (!viewState.groups.some((group) => group.id === viewState.activeGroupId)) {
            viewState.activeGroupId = viewState.groups[0]?.id || null;
        }
        syncSelectionCount();
        renderGroups();
    }

    function showTimelineTooltip(button) {
        const { tooltip, timeline } = getEls();
        if (!tooltip || !timeline || !button) return;
        tooltip.textContent = button.dataset.label || '';
        tooltip.classList.remove('hidden');
        const timelineRect = timeline.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        tooltip.style.top = `${buttonRect.top - timelineRect.top - 8}px`;
    }

    function hideTimelineTooltip() {
        const { tooltip } = getEls();
        tooltip?.classList.add('hidden');
    }

    function jumpToGroup(groupId) {
        const { scroll } = getEls();
        if (!scroll || !groupId) return;
        const row = viewState.rows.find((entry) => entry.type === 'header' && entry.group.id === groupId);
        if (!row) return;
        scroll.scrollTo({ top: Math.max(0, row.top - 8), behavior: 'smooth' });
        viewState.activeGroupId = groupId;
        renderTimeline(viewState.groups);
    }

    function updateActiveGroupFromScroll() {
        const { scroll } = getEls();
        if (!scroll || !viewState.rows.length) return;
        const targetTop = scroll.scrollTop + GROUP_HEADER_HEIGHT;
        let activeId = viewState.groups[0]?.id || null;
        for (const row of viewState.rows) {
            if (row.type !== 'header') continue;
            if (row.top <= targetTop) activeId = row.group.id;
            else break;
        }
        if (activeId && activeId !== viewState.activeGroupId) {
            viewState.activeGroupId = activeId;
            renderTimeline(viewState.groups);
        }
    }

    function onScroll() {
        if (viewState.renderFrame) return;
        viewState.renderFrame = windowRef.requestAnimationFrame(() => {
            viewState.renderFrame = 0;
            renderVirtualWindow();
            updateActiveGroupFromScroll();
        });
    }

    function open() {
        const { modal } = getEls();
        if (!modal) return;
        modal.classList.remove('hidden');
        refresh();
    }

    function syncBatchButton() {
        const button = documentRef.getElementById('btn-history-fullscreen-batch');
        if (!button) return;
        button.classList.toggle('active', state.historySelectionMode === true);
        button.textContent = state.historySelectionMode ? '退出批量' : '批量选择';
        button.setAttribute('aria-pressed', state.historySelectionMode ? 'true' : 'false');
    }

    function close() {
        const { modal, list, timeline, batchToolbar, count, summary } = getEls();
        modal?.classList.add('hidden');
        hideTimelineTooltip();
        viewState.version += 1;
        state.historySelectionMode = false;
        state.selectedHistoryIds.clear();
        batchToolbar?.classList.add('hidden');
        syncBatchButton();
        viewState.renderedRangeKey = '';
        if (list) {
            clearRenderedRows(list);
            list.style.height = '';
        }
        if (timeline) timeline.innerHTML = '';
        if (count) count.textContent = '0';
        if (summary) summary.textContent = '按大概时间分组浏览历史记录';
        releaseViewState();
    }

    function enterBatchMode() {
        const { batchToolbar } = getEls();
        state.historySelectionMode = true;
        state.selectedHistoryIds.clear();
        batchToolbar?.classList.remove('hidden');
        syncSelectionCount();
        syncBatchButton();
        renderVirtualWindow({ force: true });
    }

    function exitBatchMode() {
        const { batchToolbar } = getEls();
        state.historySelectionMode = false;
        state.selectedHistoryIds.clear();
        batchToolbar?.classList.add('hidden');
        syncSelectionCount();
        syncBatchButton();
        renderVirtualWindow({ force: true });
    }

    function toggleBatchMode() {
        if (state.historySelectionMode) {
            exitBatchMode();
        } else {
            enterBatchMode();
        }
    }

    async function selectAll() {
        viewState.items.forEach((item) => state.selectedHistoryIds.add(item.id));
        syncSelectionCount();
        renderVirtualWindow({ force: true });
    }

    async function deleteSelected() {
        if (state.selectedHistoryIds.size === 0) {
            showToast('请先选择要删除的历史记录', 'warn');
            return;
        }
        if (!confirmRef(`确定要删除选中的 ${state.selectedHistoryIds.size} 条历史记录吗？`)) return;
        await deleteHistoryItems(Array.from(state.selectedHistoryIds));
        state.selectedHistoryIds.clear();
        await refresh();
        exitBatchMode();
        showToast('已删除选中的历史记录', 'success');
    }

    async function downloadSelected() {
        if (state.selectedHistoryIds.size === 0) {
            showToast('请先选择要下载的历史记录', 'warn');
            return;
        }
        const selected = viewState.items.filter((item) => state.selectedHistoryIds.has(item.id));
        for (const item of selected) {
            const entry = await getHistoryEntry(item.id);
            if (entry?.mediaType === 'video' || entry?.videoBlob) {
                const blob = entry.videoBlob || entry.video;
                if (blob instanceof Blob) {
                    const url = URL.createObjectURL(blob);
                    const link = documentRef.createElement('a');
                    const mime = String(entry.videoMimeType || blob.type || '').toLowerCase();
                    const ext = mime.includes('webm') ? '.webm' : mime.includes('quicktime') ? '.mov' : '.mp4';
                    link.href = url;
                    link.download = `cainflow_${entry.id}${ext}`;
                    documentRef.body.appendChild(link);
                    link.click();
                    documentRef.body.removeChild(link);
                    windowRef.setTimeout(() => URL.revokeObjectURL(url), 1000);
                } else if (entry.videoUrl) {
                    windowRef.open(entry.videoUrl, '_blank', 'noopener,noreferrer');
                }
            } else if (entry?.image) {
                downloadImage(entry.image, `cainflow_${entry.id}.png`);
            }
            await new Promise((resolve) => setTimeout(resolve, 180));
        }
        showToast(`已开始下载 ${selected.length} 条历史记录`, 'success');
    }

    async function handleClearHistory() {
        if (!confirmRef('确定要清空全部历史记录吗？此操作无法撤销。')) return;
        await clearHistory();
        await refresh();
        showToast('历史记录已清空', 'info');
    }

    function bindStaticEvents() {
        if (viewState.scrollHandlerBound) return;
        const { scroll, modal } = getEls();
        ensureModalObserver();

        bindCardEvents();

        documentRef.getElementById('btn-close-history-fullscreen')?.addEventListener('click', close);
        documentRef.getElementById('btn-history-fullscreen-batch')?.addEventListener('click', toggleBatchMode);
        documentRef.getElementById('btn-history-fullscreen-cancel')?.addEventListener('click', exitBatchMode);
        documentRef.getElementById('btn-history-fullscreen-select-all')?.addEventListener('click', selectAll);
        documentRef.getElementById('btn-history-fullscreen-delete')?.addEventListener('click', deleteSelected);
        documentRef.getElementById('btn-history-fullscreen-download')?.addEventListener('click', downloadSelected);
        documentRef.getElementById('btn-history-fullscreen-clear')?.addEventListener('click', handleClearHistory);

        modal?.addEventListener('click', (event) => {
            if (event.target === modal) close();
        });

        scroll?.addEventListener('scroll', onScroll, { passive: true });

        windowRef.addEventListener('resize', () => {
            if (!getEls().modal?.classList.contains('hidden') && viewState.items.length) {
                buildVirtualRows();
                renderVirtualWindow({ force: true });
            }
        }, { passive: true });

        documentRef.addEventListener('keydown', (event) => {
            const { modal: currentModal } = getEls();
            if (event.key === 'Escape' && currentModal && !currentModal.classList.contains('hidden')) {
                close();
            }
        });

        viewState.scrollHandlerBound = true;
    }

    return {
        initHistoryFullscreen() {
            bindStaticEvents();
        },
        open,
        close,
        refresh,
        isOpen: () => !getEls().modal?.classList.contains('hidden')
    };
}
