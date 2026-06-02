/**
 * Tracks node-originated provider requests and renders today's request statistics.
 */
const DEFAULT_STORAGE_KEY = 'cainflow_request_statistics';
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const MAX_RECORDS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getLocalDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getLocalDateFromDayKey(dayKey) {
    const match = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date();
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
}

function shiftDayKey(dayKey, offsetDays) {
    const date = getLocalDateFromDayKey(dayKey);
    date.setDate(date.getDate() + offsetDays);
    return getLocalDayKey(date.getTime());
}

function getDayStartTime(dayKey = getLocalDayKey()) {
    return getLocalDateFromDayKey(dayKey).getTime();
}

function getEarliestViewableDayKey(days = DEFAULT_RETENTION_DAYS) {
    const normalizedDays = Math.max(1, days);
    const date = getLocalDateFromDayKey(getLocalDayKey());
    date.setDate(date.getDate() - (normalizedDays - 1));
    return getLocalDayKey(date.getTime());
}

function clampViewDayKey(dayKey, retentionDays) {
    const earliest = getEarliestViewableDayKey(retentionDays);
    const today = getLocalDayKey();
    if (dayKey < earliest) return earliest;
    if (dayKey > today) return today;
    return dayKey || today;
}

function formatDayLabel(dayKey) {
    const today = getLocalDayKey();
    if (dayKey === today) return '今天';
    if (dayKey === shiftDayKey(today, -1)) return '昨天';
    return dayKey;
}

function safeText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeRecord(raw = {}) {
    const timestamp = Number(raw.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const providerId = safeText(raw.providerId, 'unknown');
    return {
        id: safeText(raw.id, `req_${timestamp}`),
        timestamp,
        dayKey: safeText(raw.dayKey, getLocalDayKey(timestamp)),
        success: raw.success === true,
        status: Number.isFinite(Number(raw.status)) ? Number(raw.status) : null,
        nodeId: safeText(raw.nodeId),
        nodeType: safeText(raw.nodeType),
        providerId,
        providerName: safeText(raw.providerName, providerId),
        modelName: safeText(raw.modelName),
        url: safeText(raw.url)
    };
}

function calculateSuccessRate(successCount, totalCount) {
    if (!totalCount) return 0;
    return Math.round((successCount / totalCount) * 1000) / 10;
}

function sortProviders(providers, sortBy) {
    return providers.sort((a, b) => {
        if (sortBy === 'successRate') {
            if (b.successRate !== a.successRate) return b.successRate - a.successRate;
            if (b.total !== a.total) return b.total - a.total;
        } else if (b.total !== a.total) {
            return b.total - a.total;
        }
        return a.providerName.localeCompare(b.providerName, 'zh-CN');
    });
}

export function createRequestStatisticsApi({
    state,
    documentRef = document,
    localStorageRef = localStorage,
    storageKey = DEFAULT_STORAGE_KEY
}) {
    let initialized = false;
    let sortBy = 'requestCount';
    let retentionDays = DEFAULT_RETENTION_DAYS;
    let selectedDayKey = getLocalDayKey();

    function getRecords() {
        state.requestStatistics = Array.isArray(state.requestStatistics)
            ? state.requestStatistics
            : [];
        return state.requestStatistics;
    }

    function persist() {
        try {
            localStorageRef.setItem(storageKey, JSON.stringify({
                retentionDays,
                records: getRecords().slice(0, MAX_RECORDS)
            }));
        } catch (error) {
            console.warn('Persist request statistics failed:', error);
        }
    }

    function normalizeRetentionDays(value) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
        return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, parsed));
    }

    function getRetentionCutoffTime(days = retentionDays) {
        const normalizedDays = normalizeRetentionDays(days);
        return Date.now() - (normalizedDays * DAY_MS);
    }

    function pruneExpiredRecords(days = retentionDays) {
        const cutoffTime = getRetentionCutoffTime(days);
        const records = getRecords();
        const filtered = records.filter((record) => record.timestamp >= cutoffTime);
        if (filtered.length === records.length) return false;
        state.requestStatistics = filtered;
        return true;
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        try {
            const parsed = JSON.parse(localStorageRef.getItem(storageKey) || '{}');
            const loaded = Array.isArray(parsed?.records) ? parsed.records : [];
            retentionDays = normalizeRetentionDays(parsed?.retentionDays ?? DEFAULT_RETENTION_DAYS);
            state.requestStatistics = loaded
                .map(normalizeRecord)
                .filter(Boolean)
                .slice(0, MAX_RECORDS);
            pruneExpiredRecords(retentionDays);
            selectedDayKey = clampViewDayKey(selectedDayKey, retentionDays);
            persist();
        } catch (error) {
            state.requestStatistics = [];
            retentionDays = DEFAULT_RETENTION_DAYS;
            console.warn('Load request statistics failed:', error);
        }
    }

    function prune() {
        const records = getRecords();
        if (records.length <= MAX_RECORDS) return false;
        state.requestStatistics = records.slice(0, MAX_RECORDS);
        return true;
    }

    function recordNodeRequest({
        nodeId = '',
        nodeType = '',
        providerId = '',
        providerName = '',
        modelName = '',
        url = '',
        status = null,
        success = false
    } = {}) {
        initialize();
        const timestamp = Date.now();
        const normalizedProviderId = safeText(providerId, safeText(providerName, 'unknown'));
        const record = normalizeRecord({
            id: `req_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp,
            dayKey: getLocalDayKey(timestamp),
            success: success === true,
            status,
            nodeId,
            nodeType,
            providerId: normalizedProviderId,
            providerName: safeText(providerName, normalizedProviderId),
            modelName,
            url
        });
        if (!record) return null;
        getRecords().unshift(record);
        prune();
        pruneExpiredRecords();
        selectedDayKey = clampViewDayKey(selectedDayKey, retentionDays);
        persist();
        if (documentRef.getElementById('statistics-sidebar')?.classList.contains('active')) {
            render();
        }
        return record;
    }

    function getDaySummary(dayKey = selectedDayKey) {
        initialize();
        selectedDayKey = clampViewDayKey(dayKey, retentionDays);
        const records = getRecords().filter((record) => record.dayKey === selectedDayKey);
        const total = records.length;
        const success = records.filter((record) => record.success).length;
        const failed = total - success;
        const providersById = new Map();

        records.forEach((record) => {
            const key = record.providerId || record.providerName || 'unknown';
            const current = providersById.get(key) || {
                providerId: key,
                providerName: record.providerName || key,
                total: 0,
                success: 0,
                failed: 0,
                successRate: 0
            };
            current.total += 1;
            if (record.success) current.success += 1;
            else current.failed += 1;
            current.successRate = calculateSuccessRate(current.success, current.total);
            providersById.set(key, current);
        });

        return {
            total,
            success,
            failed,
            successRate: calculateSuccessRate(success, total),
            dayKey: selectedDayKey,
            dayLabel: formatDayLabel(selectedDayKey),
            earliestDayKey: getEarliestViewableDayKey(retentionDays),
            todayKey: getLocalDayKey(),
            providers: sortProviders(Array.from(providersById.values()), sortBy)
        };
    }

    function render() {
        const summary = getDaySummary();
        const titleEl = documentRef.getElementById('statistics-panel-title');
        const totalEl = documentRef.getElementById('statistics-total-requests');
        const rateEl = documentRef.getElementById('statistics-success-rate');
        const listEl = documentRef.getElementById('statistics-provider-ranking');
        const emptyEl = documentRef.getElementById('statistics-empty');
        const updatedEl = documentRef.getElementById('statistics-updated-time');
        const sortSelect = documentRef.getElementById('statistics-ranking-sort');
        const currentDayEl = documentRef.getElementById('statistics-current-day');
        const prevDayBtn = documentRef.getElementById('statistics-prev-day');
        const nextDayBtn = documentRef.getElementById('statistics-next-day');

        if (sortSelect) sortSelect.value = sortBy;
        if (titleEl) titleEl.textContent = `${summary.dayLabel}请求统计`;
        if (totalEl) totalEl.textContent = String(summary.total);
        if (rateEl) {
            rateEl.textContent = summary.total ? `${summary.successRate}%` : '0%';
            rateEl.title = `成功 ${summary.success} 次，失败 ${summary.failed} 次`;
        }
        if (updatedEl) updatedEl.textContent = new Date().toLocaleTimeString();
        if (currentDayEl) {
            currentDayEl.textContent = summary.dayLabel === '今天'
                ? '今天'
                : `${summary.dayLabel}`;
            currentDayEl.title = summary.dayKey;
        }
        if (prevDayBtn) {
            const disabled = getDayStartTime(summary.dayKey) <= getDayStartTime(summary.earliestDayKey);
            prevDayBtn.disabled = disabled;
            prevDayBtn.setAttribute('aria-disabled', String(disabled));
            prevDayBtn.title = disabled ? '已经到达保留范围内最早的一天' : '查看上一天';
        }
        if (nextDayBtn) {
            const disabled = getDayStartTime(summary.dayKey) >= getDayStartTime(summary.todayKey);
            nextDayBtn.disabled = disabled;
            nextDayBtn.setAttribute('aria-disabled', String(disabled));
            nextDayBtn.title = disabled ? '已经是今天' : '查看下一天';
        }
        if (emptyEl) emptyEl.classList.toggle('hidden', summary.total > 0);
        if (emptyEl) emptyEl.textContent = `${summary.dayLabel}还没有节点请求记录`;
        if (!listEl) return;

        if (summary.providers.length === 0) {
            listEl.innerHTML = '';
            return;
        }

        const maxTotal = Math.max(...summary.providers.map((provider) => provider.total), 1);
        listEl.innerHTML = summary.providers.map((provider, index) => {
            const width = sortBy === 'successRate'
                ? provider.successRate
                : Math.max(8, (provider.total / maxTotal) * 100);
            return `
                <div class="statistics-provider-row">
                    <div class="statistics-provider-rank">${index + 1}</div>
                    <div class="statistics-provider-main">
                        <div class="statistics-provider-heading">
                            <span class="statistics-provider-name">${escapeHtml(provider.providerName)}</span>
                            <span class="statistics-provider-count">${provider.total} 次</span>
                        </div>
                        <div class="statistics-provider-bar" aria-hidden="true">
                            <span style="width:${Math.max(0, Math.min(100, width))}%"></span>
                        </div>
                        <div class="statistics-provider-meta">
                            <span>成功率 ${provider.successRate}%</span>
                            <span>成功 ${provider.success} / 失败 ${provider.failed}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function setSortBy(value) {
        sortBy = value === 'successRate' ? 'successRate' : 'requestCount';
        render();
    }

    function shiftSelectedDay(offsetDays) {
        initialize();
        selectedDayKey = clampViewDayKey(shiftDayKey(selectedDayKey, offsetDays), retentionDays);
        render();
        return selectedDayKey;
    }

    function setRetentionDays(value) {
        initialize();
        retentionDays = normalizeRetentionDays(value);
        pruneExpiredRecords();
        prune();
        selectedDayKey = clampViewDayKey(selectedDayKey, retentionDays);
        persist();
        render();
        return retentionDays;
    }

    return {
        initialize,
        recordNodeRequest,
        render,
        setSortBy,
        getTodaySummary: () => getDaySummary(getLocalDayKey()),
        getDaySummary,
        shiftSelectedDay,
        setRetentionDays,
        getRetentionDays: () => {
            initialize();
            return retentionDays;
        }
    };
}
