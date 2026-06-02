/**
 * 负责日志面板的数据整理、渲染与错误详情展示，统一处理执行日志输出。
 */
import { sanitizeDetails, sanitizeRequestUrl } from '../../services/api-client.js';

const MAX_LOG_COUNT = 200;
const DEFAULT_RETENTION_DAYS = 1;
const DUPLICATE_LOG_WINDOW_MS = 2000;

function normalizeRetentionDayCount(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_RETENTION_DAYS;
}

function getLocalDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getEarliestRetainedDayKey(days = DEFAULT_RETENTION_DAYS) {
    const normalizedDays = normalizeRetentionDayCount(days);
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (normalizedDays - 1));
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

    function normalizeRetentionDays(value) {
        return normalizeRetentionDayCount(value);
    }

    function persistLogs() {
        try {
            localStorageRef.setItem(storageKey, JSON.stringify({
                logs: (Array.isArray(state.logs) ? state.logs : []).map((log) => ({
                    ...log,
                    rawDetails: null
                })),
                logRetentionDays: normalizeRetentionDays(state.logRetentionDays)
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
                    const nextDetails = sanitizeDetails(log?.details ?? log?.rawDetails ?? null);
                    if (nextDetails !== log?.details) shouldRewritePersistedLogs = true;
                    return {
                        ...log,
                        details: nextDetails,
                        rawDetails: null
                    };
                });
            }
            if (parsed?.logRetentionDays !== undefined) {
                state.logRetentionDays = normalizeRetentionDays(parsed.logRetentionDays);
            }
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
        state.logRetentionDays = normalizeRetentionDays(state.logRetentionDays);
        state.logs = Array.isArray(state.logs) ? state.logs : [];
        logsInitialized = true;
    }

    function pruneExpiredLogs(options = {}) {
        const earliestDayKey = getEarliestRetainedDayKey(options.retentionDays ?? state.logRetentionDays);
        const beforeCount = Array.isArray(state.logs) ? state.logs.length : 0;
        state.logs = (Array.isArray(state.logs) ? state.logs : []).filter((log) => {
            const timestamp = Number(log?.timestamp);
            return Number.isFinite(timestamp) && getLocalDayKey(timestamp) >= earliestDayKey;
        }).slice(0, MAX_LOG_COUNT);
        const changed = state.logs.length !== beforeCount;
        if (changed && options.save !== false) persistLogs();
        return changed;
    }

    function syncRetentionControl() {
        if (elements.logRetentionSelect) {
            elements.logRetentionSelect.value = String(normalizeRetentionDays(state.logRetentionDays));
        }
    }

    function initializeLogs() {
        ensureLogsInitialized();
        pruneExpiredLogs({ save: true, retentionDays: state.logRetentionDays });
        syncRetentionControl();
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
        const sanitized = sanitizeDetails(details);
        const rawDetails = details === null || details === undefined ? null : details;
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
                    <span class="log-summary-text">${log.title}</span>
                </div>
                ${log.details?.finalUrl ? `<div class="log-request-url" title="${log.details.finalUrl}">URL: ${log.details.finalUrl}</div>` : ''}
                <span class="log-time-hint">${log.time}</span>
            </div>
        `).join('');
    }

    function showLogDetail(id) {
        ensureLogsInitialized();
        const log = state.logs.find((entry) => entry.id === id);
        if (!log) return;
        renderErrorModal(log.title, log.message, log.details, log.type === 'error' ? '执行错误' : '执行详情', log);
    }

    function setLogRetentionDays(value) {
        ensureLogsInitialized();
        const nextDays = normalizeRetentionDays(value);
        if (state.logRetentionDays === nextDays) {
            syncRetentionControl();
            return false;
        }
        state.logRetentionDays = nextDays;
        pruneExpiredLogs({ save: true, retentionDays: nextDays });
        renderLogs();
        syncRetentionControl();
        return true;
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
        setLogRetentionDays,
        syncRetentionControl,
        showLogDetail
    };
}
/**
 * 管理执行日志面板的数据记录、展示和详情查看。
 */
