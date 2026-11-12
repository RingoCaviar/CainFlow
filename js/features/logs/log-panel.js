/**
 * 负责日志面板的数据整理、渲染与错误详情展示，统一处理执行日志输出。
 */
import { sanitizeDetails, sanitizeRequestUrl } from '../../services/api-client.js';

const MAX_LOG_COUNT = 200;
const RETENTION_DAYS = 7;
const MAX_LOG_RECORD_BYTES = 16 * 1024;
const DUPLICATE_LOG_WINDOW_MS = 2000;
const REQUEST_URL_PREFIX = '最终请求 URL: ';
const LOG_STATUS = {
    success: { label: '成功', icon: '<path d="m3 8 3.25 3.25L13 4.5"/>' },
    error: { label: '错误', icon: '<circle cx="8" cy="8" r="5.75"/><path d="m6 6 4 4m0-4-4 4"/>' },
    warning: {
        label: '警告',
        icon: '<path d="M7.1 2.8 2 12.1a1 1 0 0 0 .9 1.5h10.2a1 1 0 0 0 .9-1.5L8.9 2.8a1 1 0 0 0-1.8 0Z"/><path d="M8 6v2.6m0 2.6h.01"/>'
    },
    info: { label: '信息', icon: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.5v3.25m0-5.5h.01"/>' },
    pending: { label: '请求中', icon: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>' },
    canceled: { label: '已取消', icon: '<circle cx="8" cy="8" r="5.75"/><path d="M5.5 8h5"/>' },
    interrupted: { label: '已中断', icon: '<circle cx="8" cy="8" r="5.75"/><path d="M6.5 5.75v4.5m3-4.5v4.5"/>' }
};

function getLogType(log) {
    if (log.requestStatus === 'failed') return 'error';
    const type = log.requestStatus || log.type;
    return Object.hasOwn(LOG_STATUS, type) ? type : 'info';
}

function getRequestFailureMessage({ error, status }) {
    const reason = typeof error === 'string' ? error : error?.message;
    return sanitizeDetails(reason) || (Number.isInteger(status) ? `HTTP ${status}` : '');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function boundDetails(value) {
    if (value === null || value === undefined) return null;
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    if (encoded.length <= MAX_LOG_RECORD_BYTES) return value;
    return { truncated: true, originalBytes: encoded.length, preview: JSON.stringify(value).slice(0, 2000) };
}

function getLocalDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getEarliestRetainedDayKey() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (RETENTION_DAYS - 1));
    return getLocalDayKey(date.getTime());
}

export function createLogPanelApi({
    state,
    elements,
    renderErrorModal,
    saveState = () => {},
    localStorageRef = localStorage,
    storageKey = 'cainflow_logs_state'
}) {
    let logsInitialized = false;
    let logFilter = 'all';
    const filterButtons = elements.logFilters?.querySelectorAll('[data-log-filter]') || [];

    elements.logFilters?.addEventListener('click', (event) => {
        const filter = event.target.closest('[data-log-filter]')?.dataset.logFilter;
        if (!['all', 'failed'].includes(filter) || filter === logFilter) return;
        logFilter = filter;
        if (elements.logList) elements.logList.scrollTop = 0;
        renderLogs();
    });
    elements.logList?.addEventListener?.('click', (event) => {
        const id = event.target.closest('[data-log-id]')?.dataset.logId;
        if (id) showLogDetail(id);
    });

    function persistLogs() {
        try {
            localStorageRef.setItem(storageKey, JSON.stringify({
                logs: (Array.isArray(state.logs) ? state.logs : []).map((log) => ({
                    ...log,
                    rawDetails: null
                }))
            }));
        } catch (error) {
            console.warn('Persist logs failed:', error);
        }
    }

    function loadPersistedLogs() {
        try {
            const raw = localStorageRef.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            let shouldRewritePersistedLogs = false;
            if (Array.isArray(parsed?.logs)) {
                state.logs = parsed.logs.map((log) => {
                    if (log?.rawDetails) shouldRewritePersistedLogs = true;
                    const requestStatus = log?.requestStatus === 'pending' ? 'interrupted' : log?.requestStatus;
                    if (requestStatus !== log?.requestStatus) shouldRewritePersistedLogs = true;
                    const nextDetails = boundDetails(sanitizeDetails(log?.details ?? log?.rawDetails ?? null));
                    if (nextDetails !== log?.details) shouldRewritePersistedLogs = true;
                    return {
                        ...log,
                        ...(requestStatus ? { requestStatus } : {}),
                        details: nextDetails,
                        rawDetails: null
                    };
                });
            }
            if (parsed?.logRetentionDays !== undefined) shouldRewritePersistedLogs = true;
            if (shouldRewritePersistedLogs) {
                persistLogs();
            }
        } catch (error) {
            console.warn('Load persisted logs failed:', error);
        }
    }

    function ensureLogsInitialized() {
        if (logsInitialized) return;
        loadPersistedLogs();
        state.logs = Array.isArray(state.logs) ? state.logs : [];
        logsInitialized = true;
    }

    function pruneExpiredLogs(options = {}) {
        const earliestDayKey = getEarliestRetainedDayKey();
        const beforeCount = Array.isArray(state.logs) ? state.logs.length : 0;
        state.logs = (Array.isArray(state.logs) ? state.logs : []).filter((log) => {
            const timestamp = Number(log?.timestamp);
            return Number.isFinite(timestamp) && getLocalDayKey(timestamp) >= earliestDayKey;
        }).slice(0, MAX_LOG_COUNT);
        const changed = state.logs.length !== beforeCount;
        if (changed && options.save !== false) persistLogs();
        return changed;
    }

    function initializeLogs() {
        ensureLogsInitialized();
        pruneExpiredLogs({ save: true });
    }

    function logRequestToPanel(title, url, requestBody, extra = {}) {
        const finalUrl = sanitizeRequestUrl(url);
        const { requestStatus, ...metadata } = extra;
        const details = {
            finalUrl,
            ...metadata,
            requestBody
        };
        const urlMessage = REQUEST_URL_PREFIX + finalUrl;
        const message = requestStatus === 'failed' ? getRequestFailureMessage(metadata) || urlMessage : urlMessage;
        const log = addLog('info', title, message, details, {
            requestStatus, requestUrl: finalUrl, nodeId: metadata.nodeId, nodeTitle: metadata.nodeTitle
        });
        if (requestStatus !== 'pending') return;
        return (outcome, result = {}) => {
            if (log.requestStatus !== 'pending' || !['success', 'failed', 'canceled'].includes(outcome) || !state.logs.includes(log)) return;
            log.requestStatus = outcome;
            if (outcome === 'failed') log.message = getRequestFailureMessage(result) || urlMessage;
            log.details = boundDetails(sanitizeDetails({ ...result, ...details }));
            log.rawDetails = log.details;
            renderLogs();
            persistLogs();
        };
    }

    function addLog(type, title, message, details = null, meta = {}) {
        ensureLogsInitialized();
        const sanitized = boundDetails(sanitizeDetails(details));
        const rawDetails = sanitized;
        const now = Date.now();
        const latestLog = Array.isArray(state.logs) ? state.logs[0] : null;
        if (
            !meta.requestStatus &&
            latestLog &&
            !latestLog.requestStatus &&
            latestLog.type === type &&
            latestLog.title === title &&
            latestLog.message === message &&
            JSON.stringify(latestLog.details ?? null) === JSON.stringify(sanitized ?? null) &&
            now - Number(latestLog.timestamp || 0) <= DUPLICATE_LOG_WINDOW_MS
        ) {
            return latestLog;
        }
        const log = {
            id: `log_${now}${Math.random().toString(36).substr(2, 5)}`,
            timestamp: now,
            time: new Date().toLocaleTimeString(),
            type,
            title,
            message,
            details: sanitized,
            rawDetails,
            userFacing: meta?.userFacing || null,
            nodeId: meta?.nodeId || '',
            nodeTitle: meta?.nodeTitle || '',
            ...(meta.requestStatus ? { requestStatus: meta.requestStatus } : {}),
            ...(meta.requestUrl ? { requestUrl: meta.requestUrl } : {})
        };
        state.logs.unshift(log);
        pruneExpiredLogs({ save: false });
        renderLogs();
        persistLogs();

        if (type === 'error' && !state.autoRetry) {
            renderErrorModal(title, message, log.details, log.nodeTitle ? `${log.nodeTitle}：执行错误` : '执行错误', log);
        } else if (type === 'error' && state.autoRetry && elements.btnLogs) {
            elements.btnLogs.classList.add('has-new-error');
        }
        return log;
    }

    function renderLogs() {
        ensureLogsInitialized();
        const list = elements.logList;
        if (!list) return;
        pruneExpiredLogs({ save: true });
        const failed = state.logs.filter(log => getLogType(log) === 'error');
        for (const button of filterButtons) {
            const filter = button.dataset.logFilter;
            const count = String(filter === 'failed' ? failed.length : state.logs.length);
            button.setAttribute('aria-pressed', String(logFilter === filter));
            const label = button.querySelector('[data-log-count]');
            if (label.textContent !== count) label.textContent = count;
        }
        const visibleLogs = logFilter === 'failed' ? failed : state.logs;
        if (!visibleLogs.length) {
            list.innerHTML = `<div class="log-empty">${logFilter === 'failed' ? '暂无失败记录' : '暂无执行记录'}</div>`;
            return;
        }

        const focusedLogId = list.ownerDocument?.activeElement?.dataset.logId;
        list.innerHTML = visibleLogs.map((log) => {
            const type = getLogType(log);
            const { label, icon } = LOG_STATUS[type];
            const message = String(log.message ?? '');
            const requestUrl = sanitizeRequestUrl(log.requestUrl || (message.startsWith(REQUEST_URL_PREFIX) ? message.slice(REQUEST_URL_PREFIX.length) : ''));
            const reason = type === 'error' && message !== REQUEST_URL_PREFIX + requestUrl ? sanitizeDetails(message) : '';
            const summary = reason || requestUrl;
            return `
                <button type="button" class="log-item ${type}" data-log-id="${escapeHtml(log.id)}" title="查看详情">
                    <span class="log-item-main">
                        <span class="log-type-tag">
                            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
                            ${log.requestStatus === 'failed' ? '失败' : label}
                        </span>
                        <span class="log-summary-text">${escapeHtml(log.title)}</span>
                        <span class="log-time-hint">${escapeHtml(log.time)}</span>
                    </span>
                    ${summary ? `<span class="log-item-summary${reason ? '' : ' log-request-url'}">${escapeHtml(summary)}</span>` : ''}
                </button>
            `;
        }).join('');
        if (focusedLogId) {
            Array.from(list.children).find(row => row.dataset.logId === focusedLogId)?.focus({ preventScroll: true });
        }
    }

    function showLogDetail(id) {
        ensureLogsInitialized();
        const log = state.logs.find((entry) => entry.id === id);
        if (!log) return;
        const type = getLogType(log);
        const modalTitle = log.requestStatus === 'failed' ? '请求失败'
            : type === 'error' ? (log.nodeTitle ? `${log.nodeTitle}：执行错误` : '执行错误') : '执行详情';
        renderErrorModal(
            log.title,
            log.message,
            log.details,
            modalTitle,
            { ...log, type }
        );
    }

    function clearLogs() {
        ensureLogsInitialized();
        state.logs = [];
        persistLogs();
        renderLogs();
        saveState();
    }

    return {
        addLog,
        clearLogs,
        initializeLogs,
        logRequestToPanel,
        renderLogs,
        pruneExpiredLogs,
        showLogDetail
    };
}
/**
 * 管理执行日志面板的数据记录、展示和详情查看。
 */
