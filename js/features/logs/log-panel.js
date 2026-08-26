/**
 * 负责日志面板的数据整理、渲染与错误详情展示，统一处理执行日志输出。
 */
import { sanitizeDetails, sanitizeRequestUrl } from '../../services/api-client.js';

const MAX_LOG_COUNT = 200;
const RETENTION_DAYS = 7;
const MAX_LOG_RECORD_BYTES = 16 * 1024;
const DUPLICATE_LOG_WINDOW_MS = 2000;

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
                    const nextDetails = boundDetails(sanitizeDetails(log?.details ?? log?.rawDetails ?? null));
                    if (nextDetails !== log?.details) shouldRewritePersistedLogs = true;
                    return {
                        ...log,
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
        addLog('info', title, `最终请求 URL: ${finalUrl}`, {
            url,
            finalUrl,
            ...extra,
            requestBody
        });
    }

    function addLog(type, title, message, details = null, meta = {}) {
        ensureLogsInitialized();
        const sanitized = boundDetails(sanitizeDetails(details));
        const rawDetails = sanitized;
        const now = Date.now();
        const latestLog = Array.isArray(state.logs) ? state.logs[0] : null;
        if (
            latestLog &&
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
            userFacing: meta?.userFacing || null
        };
        state.logs.unshift(log);
        pruneExpiredLogs({ save: false });
        renderLogs();
        persistLogs();

        if (type === 'error' && !state.autoRetry) {
            renderErrorModal(title, message, log.details, '执行错误', log);
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
        if (state.logs.length === 0) {
            list.innerHTML = '<div class="log-empty">暂无执行记录</div>';
            return;
        }

        const typeLabels = {
            success: '成功',
            error: '错误',
            warning: '警告',
            info: '信息'
        };

        list.innerHTML = state.logs.map((log) => `
            <div class="log-item ${log.type}" onclick="showLogDetail('${log.id}')" title="点击查看详情">
                <div class="log-item-main">
                    <span class="log-type-tag">${typeLabels[log.type] || '日志'}</span>
                    <span class="log-summary-text">${escapeHtml(log.title)}</span>
                </div>
                ${log.details?.finalUrl ? `<div class="log-request-url" title="${escapeHtml(log.details.finalUrl)}">URL: ${escapeHtml(log.details.finalUrl)}</div>` : ''}
                <span class="log-time-hint">${escapeHtml(log.time)}</span>
            </div>
        `).join('');
    }

    function showLogDetail(id) {
        ensureLogsInitialized();
        const log = state.logs.find((entry) => entry.id === id);
        if (!log) return;
        renderErrorModal(log.title, log.message, log.details, log.type === 'error' ? '执行错误' : '执行详情', log);
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
