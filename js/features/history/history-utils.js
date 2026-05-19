/**
 * 历史记录渲染、按天分组和时间标签的通用工具。
 */
const TRANSPARENT_HISTORY_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function escapeHistoryHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function startOfDay(timestamp) {
    const date = new Date(timestamp || 0);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

export function buildHistoryTimeLabel(timestamp, now = Date.now()) {
    const currentDay = startOfDay(now);
    const targetDay = startOfDay(timestamp);
    const diffDays = Math.round((currentDay - targetDay) / (24 * 60 * 60 * 1000));
    const date = new Date(timestamp || 0);

    if (Number.isNaN(date.getTime())) return '未知日期';
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';

    const currentYear = new Date(now).getFullYear();
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    if (year === currentYear) return `${month}月${day}日`;
    return `${year}年${month}月${day}日`;
}

export function formatHistoryExactDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
}

export function formatHistoryGenerationDuration(duration) {
    const seconds = Number.parseFloat(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;

    const minutes = Math.floor(seconds / 60);
    const restSeconds = Math.round(seconds % 60);
    return `${minutes}m${String(restSeconds).padStart(2, '0')}s`;
}

export function groupHistoryItems(items, now = Date.now()) {
    const groups = [];
    const map = new Map();

    items.forEach((item) => {
        const dayKey = startOfDay(item.timestamp);
        const label = buildHistoryTimeLabel(item.timestamp, now);
        if (!map.has(dayKey)) {
            const group = {
                id: `group_${groups.length}`,
                dayKey,
                label,
                items: [],
                latestTimestamp: Number(item.timestamp || 0),
                earliestTimestamp: Number(item.timestamp || 0)
            };
            groups.push(group);
            map.set(dayKey, group);
        }

        const group = map.get(dayKey);
        group.items.push(item);
        group.latestTimestamp = Math.max(group.latestTimestamp, Number(item.timestamp || 0));
        group.earliestTimestamp = Math.min(group.earliestTimestamp, Number(item.timestamp || 0));
    });

    return groups;
}

export function buildHistoryCardMarkup({
    item,
    selected = false,
    multiSelectMode = false,
    compact = false
}) {
    const selectedClass = selected ? 'selected' : '';
    const multiClass = multiSelectMode ? 'multi-select-mode' : '';
    const compactClass = compact ? 'history-card-compact' : '';
    const thumb = item.thumb || '';
    const prompt = escapeHistoryHtml(item.prompt || '');
    const model = escapeHistoryHtml(item.model || '');
    const exactDate = escapeHistoryHtml(formatHistoryExactDate(item.timestamp));
    const durationText = escapeHistoryHtml(formatHistoryGenerationDuration(item.generationDurationSeconds ?? item.generationDuration));
    const imageClass = thumb ? '' : 'history-card-img-pending';

    return `
        <article class="history-card ${selectedClass} ${multiClass} ${compactClass}" data-id="${item.id}" draggable="true">
            <img class="${imageClass}" src="${escapeHistoryHtml(thumb || TRANSPARENT_HISTORY_PIXEL)}" loading="lazy" decoding="async" alt="${prompt}" />
            ${durationText ? `<span class="history-card-duration" title="生图耗时 ${durationText}">${durationText}</span>` : ''}
            <div class="selection-checkbox"></div>
            <button class="delete-btn" data-id="${item.id}" title="删除记录">×</button>
            ${compact ? '' : `
                <div class="history-card-meta">
                    <div class="history-card-meta-main">${prompt || '未命名提示词'}</div>
                    <div class="history-card-meta-sub">
                        <span>${model || '未知模型'}</span>
                        <span>${exactDate}</span>
                    </div>
                </div>
            `}
        </article>
    `;
}
