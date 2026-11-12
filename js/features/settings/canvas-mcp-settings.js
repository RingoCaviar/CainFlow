const SETTINGS_ENDPOINT = '/api/canvas-mcp/settings';

export const canvasMcpSettingsCard = `
    <div class="api-config-card general-settings-card" data-settings-card="canvas-mcp">
        <div class="card-header"><span>画布 MCP</span></div>
        <div class="card-row">
            <div class="card-field">
                <div class="general-settings-control-row">
                    <label for="setting-canvas-mcp-enabled">允许本机 MCP 客户端连接</label>
                    <label class="toggle-switch">
                        <input type="checkbox" id="setting-canvas-mcp-enabled" role="switch"
                            aria-describedby="canvas-mcp-permissions canvas-mcp-status" disabled>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <p class="general-settings-mcp-note" id="canvas-mcp-permissions">连接后，客户端可以读取、编辑和运行当前画布，并获取运行结果。</p>
                <p class="general-settings-mcp-note" id="canvas-mcp-status" role="status"></p>
                <button class="btn btn-secondary btn-sm general-settings-mcp-action" type="button" id="btn-retry-canvas-mcp-status" hidden>重新读取状态</button>
                <div id="canvas-mcp-connection-guide" hidden>
                    <p class="general-settings-mcp-note" id="canvas-mcp-connection-unavailable" hidden>未找到 stdio 客户端脚本。请从 CainFlow 源码目录运行客户端适配器。</p>
                    <div id="canvas-mcp-connection-steps" class="general-settings-mcp-guide" hidden>
                        <button class="btn btn-secondary btn-sm general-settings-mcp-action" type="button" id="btn-copy-canvas-mcp-config" disabled>复制客户端配置</button>
                        <details id="canvas-mcp-install" hidden>
                            <summary>复制后，首次使用时安装依赖</summary>
                            <p class="general-settings-mcp-note">需要 Python 3.11 或更高版本。在终端运行下面的命令（Windows 使用 PowerShell）。</p>
                            <code id="canvas-mcp-install-command"></code>
                        </details>
                        <ol>
                            <li>将配置粘贴到支持 stdio 的客户端。若已有 <code>mcpServers</code>，将 <code>cainflow-canvas</code> 加进去，然后重载客户端。</li>
                            <li>在 CainFlow 打开目标工作流，然后在客户端发送“读取 CainFlow 当前画布”。</li>
                        </ol>
                        <p class="general-settings-mcp-note">配置包含连接令牌，请只交给信任的客户端。</p>
                        <p class="general-settings-mcp-note" id="canvas-mcp-desktop-port-note" hidden>桌面版端口变更后，请重新复制配置。</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
`;

export function createCanvasMcpSettings({ fetchImpl = globalThis.fetch, windowRef, showToast, onNativeClipboardWrite }) {
    const local = windowRef?.location?.protocol === 'http:' && windowRef.location.hostname === '127.0.0.1';
    const topLevel = windowRef?.top === windowRef;
    let view;
    let status;
    let pending = '';
    let error = '';

    function render() {
        if (!view) return;
        const enabled = status?.enabled === true;
        const stdioAvailable = status?.stdioAvailable === true;
        const installCommand = status?.installCommand || '';
        view.toggle.checked = enabled;
        view.toggle.disabled = !status || Boolean(pending);
        view.status.textContent = !local ? '请通过本机地址 127.0.0.1 打开 CainFlow 后设置 MCP。'
            : !topLevel ? '请在独立标签页打开 CainFlow 后设置 MCP。'
            : error || pending || (enabled ? '已开启' : '已关闭');
        view.retry.hidden = !local || !topLevel || !error || Boolean(status) || Boolean(pending);
        view.guide.hidden = !enabled;
        view.steps.hidden = !stdioAvailable;
        view.unavailable.hidden = stdioAvailable;
        view.install.hidden = !installCommand;
        view.installCommand.textContent = installCommand;
        view.desktopPortNote.hidden = !windowRef?.__cainflowDesktop;
        view.copy.disabled = !enabled || !stdioAvailable || Boolean(pending);
    }

    async function request(action, fields = {}) {
        const response = await fetchImpl(SETTINGS_ENDPOINT, {
            method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-CainFlow-Canvas-MCP': 'settings' },
            body: JSON.stringify({ action, ...fields })
        });
        if (!response.ok) {
            throw Object.assign(new Error(`MCP settings request failed (${response.status})`), { status: response.status });
        }
        return response.json();
    }

    async function sync(action, enabled) {
        if (!local || !topLevel || pending) return;
        const changing = action === 'set_enabled';
        pending = changing ? (enabled ? '正在开启…' : '正在关闭…') : '正在读取状态…';
        error = '';
        render();
        const read = async (method, fields) => {
            const next = await request(method, fields);
            if (typeof next?.enabled !== 'boolean') throw new Error('Missing MCP status');
            status = next;
        };
        try {
            await read(action, changing ? { enabled } : undefined);
        } catch (requestError) {
            let statusError = requestError;
            if (changing) {
                // A lost response may follow a successful server-side change.
                try {
                    await read('status');
                } catch (readError) {
                    status = null;
                    statusError = readError;
                }
            } else status = null;
            if (!status) error = [404, 405].includes(statusError?.status)
                ? '当前服务未加载画布 MCP 接口，请重启 CainFlow 后重新读取。'
                : '无法读取 MCP 状态，请重试。';
        } finally {
            if (status && changing && status.enabled !== enabled) error = '切换失败，已恢复当前状态。';
            pending = '';
            render();
        }
        if (changing && status?.enabled === enabled) {
            windowRef.dispatchEvent(new windowRef.CustomEvent('cainflow:canvas-mcp-changed', {
                detail: { enabled: status.enabled }
            }));
        }
    }

    async function copyConfig() {
        if (!status?.enabled || !status.stdioAvailable || pending) return;
        pending = '正在复制配置…';
        error = '';
        render();
        try {
            const clipboard = windowRef.navigator.clipboard;
            const canWriteItem = typeof clipboard?.write === 'function' && typeof windowRef.ClipboardItem === 'function';
            const canWriteText = typeof clipboard?.writeText === 'function';
            if (!canWriteItem && !canWriteText) throw new Error('Clipboard unavailable');
            const text = request('connection_config').then(({ config }) => {
                if (!config?.mcpServers?.['cainflow-canvas']) throw new Error('Missing MCP client configuration');
                return JSON.stringify(config, null, 2);
            });
            if (canWriteItem) {
                // Start the clipboard write during the click for browsers that require user activation.
                const payload = text.then(value => new windowRef.Blob([value], { type: 'text/plain' }));
                void payload.catch(() => {});
                try {
                    const item = new windowRef.ClipboardItem({ 'text/plain': payload });
                    await Promise.all([clipboard.write([item]), payload]);
                } catch (error) {
                    if (!canWriteText) throw error;
                    await clipboard.writeText(await text);
                }
            } else await clipboard.writeText(await text);
            onNativeClipboardWrite?.();
            showToast('MCP 客户端配置已复制', 'success');
        } catch {
            showToast('无法复制 MCP 配置，请确认 MCP 已开启并允许剪贴板访问', 'error');
        } finally {
            pending = '';
            render();
        }
    }

    return {
        bind(card) {
            const get = id => card.querySelector(`#${id}`);
            view = {
                toggle: get('setting-canvas-mcp-enabled'), status: get('canvas-mcp-status'),
                retry: get('btn-retry-canvas-mcp-status'), guide: get('canvas-mcp-connection-guide'),
                unavailable: get('canvas-mcp-connection-unavailable'), steps: get('canvas-mcp-connection-steps'),
                install: get('canvas-mcp-install'), installCommand: get('canvas-mcp-install-command'),
                desktopPortNote: get('canvas-mcp-desktop-port-note'),
                copy: get('btn-copy-canvas-mcp-config')
            };
            view.toggle.addEventListener('change', event => { void sync('set_enabled', event.target.checked); });
            view.retry.addEventListener('click', () => { void sync('status'); });
            view.copy.addEventListener('click', copyConfig);
            if (local && topLevel && !pending) void sync('status');
            else render();
        }
    };
}
