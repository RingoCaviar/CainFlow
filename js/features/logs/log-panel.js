/**
 * 负责日志面板的数据整理、渲染与错误详情展示，统一处理执行日志输出。
 */
import { sanitizeDetails, sanitizeRequestUrl } from '../../services/api-client.js';

const MAX_LOG_COUNT = 200;
const DEFAULT_RETENTION_DAYS = 1;

export function createLogPanelApi({
    state,
    elements,
    renderErrorModal,
    saveState = () => {},
    localStorageRef = localStorage,
    storageKey = 'cainflow_logs_state'
}) {
    function normalizeRetentionDays(value) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_RETENTION_DAYS;
    }

    function persistLogs() {
        try {
            localStorageRef.setItem(storageKey, JSON.stringify({
                logs: Array.isArray(state.logs) ? state.logs : [],
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
            if (Array.isArray(parsed?.logs)) {
                state.logs = parsed.logs;
            }
            if (parsed?.logRetentionDays !== undefined) {
                state.logRetentionDays = normalizeRetentionDays(parsed.logRetentionDays);
            }
        } catch (error) {
            console.warn('Load persisted logs failed:', error);
        }
    }

    function getLogCutoffTimestamp(retentionDays = state.logRetentionDays) {
        return Date.now() - normalizeRetentionDays(retentionDays) * 24 * 60 * 60 * 1000;
    }

    function pruneExpiredLogs(options = {}) {
        const cutoff = getLogCutoffTimestamp(options.retentionDays);
        const beforeCount = Array.isArray(state.logs) ? state.logs.length : 0;
        state.logs = (Array.isArray(state.logs) ? state.logs : []).filter((log) => {
            const timestamp = Number(log?.timestamp);
            return Number.isFinite(timestamp) && timestamp >= cutoff;
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
        loadPersistedLogs();
        state.logRetentionDays = normalizeRetentionDays(state.logRetentionDays);
        state.logs = Array.isArray(state.logs) ? state.logs : [];
        pruneExpiredLogs({ save: true, retentionDays: state.logRetentionDays });
        syncRetentionControl();
    }

    function logRequestToPanel(title, url, requestBody, extra = {}) {
        addLog('info', title, `正在发送请求到 ${sanitizeRequestUrl(url)}`, {
            url,
            ...extra,
            requestBody
        });
    }

    function addLog(type, title, message, details = null, meta = {}) {
        const sanitized = sanitizeDetails(details);
        const now = Date.now();
        const log = {
            id: `log_${now}${Math.random().toString(36).substr(2, 5)}`,
            timestamp: now,
            time: new Date().toLocaleTimeString(),
            type,
            title,
            message,
            details: sanitized,
            rawDetails: sanitized !== details ? details : null,
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
    }

    function renderLogs() {
        const list = elements.logList;
        if (!list) return;
        pruneExpiredLogs({ save: false });
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
                <span class="log-time-hint">${log.time}</span>
            </div>
        `).join('');
    }

    function showLogDetail(id) {
        const log = state.logs.find((entry) => entry.id === id);
        if (!log) return;
        renderErrorModal(log.title, log.message, log.details, log.type === 'error' ? '执行错误' : '执行详情', log);
    }

    function setLogRetentionDays(value) {
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
