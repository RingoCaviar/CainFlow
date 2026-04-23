/**
 * 负责日志面板的数据整理、渲染与错误详情展示，统一处理执行日志输出。
 */
import { sanitizeDetails, sanitizeRequestPayload, sanitizeRequestUrl } from '../../services/api-client.js';

export function createLogPanelApi({ state, elements, renderErrorModal }) {
    function logRequestToPanel(title, url, requestBody, extra = {}) {
        addLog('info', title, `正在发送请求到 ${sanitizeRequestUrl(url)}`, {
            url: sanitizeRequestUrl(url),
            ...extra,
            requestBody: sanitizeRequestPayload(requestBody)
        });
    }

    function addLog(type, title, message, details = null, meta = {}) {
        const sanitized = sanitizeDetails(details);
        const log = {
            id: `log_${Date.now()}${Math.random().toString(36).substr(2, 5)}`,
            time: new Date().toLocaleTimeString(),
            type,
            title,
            message,
            details: sanitized,
            rawDetails: sanitized !== details ? details : null,
            userFacing: meta?.userFacing || null
        };
        state.logs.unshift(log);
        if (state.logs.length > 50) state.logs.pop();
        renderLogs();

        if (type === 'error' && !state.autoRetry) {
            renderErrorModal(title, message, log.details, '执行错误', log);
        } else if (type === 'error' && state.autoRetry && elements.btnLogs) {
            elements.btnLogs.classList.add('has-new-error');
        }
    }

    function renderLogs() {
        const list = elements.logList;
        if (!list) return;
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

    return {
        addLog,
        logRequestToPanel,
        renderLogs,
        showLogDetail
    };
}
/**
 * 管理执行日志面板的数据记录、展示和详情查看。
 */
