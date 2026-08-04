import os
import sys
import threading
from dataclasses import dataclass, field
from datetime import datetime

from backend.native_dialogs import BROWSER_STATUS_REOPEN, show_browser_mode_status


@dataclass
class BrowserServiceStatus:
    version: str
    url: str
    host: str
    port: int
    started_at: datetime
    data_dir: str
    database_path: str
    workflows_dir: str
    exports_dir: str
    log_dir: str
    random_port: bool = False
    port_fallback_reason: str = ''
    webview_reason: str = ''
    _events: list = field(default_factory=list, repr=False)
    _event_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add_event(self, message, now=None):
        timestamp = now or datetime.now().astimezone()
        entry = f'[{timestamp:%H:%M:%S}] {str(message)}'
        with self._event_lock:
            self._events.append(entry)
            del self._events[:-100]
        return entry

    def event_lines(self):
        with self._event_lock:
            return tuple(self._events)

    def uptime_seconds(self, now=None):
        current = now or datetime.now().astimezone()
        started = self.started_at
        if started.tzinfo is None and current.tzinfo is not None:
            started = started.replace(tzinfo=current.tzinfo)
        return max(0, int((current - started).total_seconds()))

    def render_terminal_text(self, now=None):
        uptime = self.uptime_seconds(now)
        hours, remainder = divmod(uptime, 3600)
        minutes, seconds = divmod(remainder, 60)
        port_mode = '系统随机端口' if self.random_port else '首选端口 8767'
        lines = [
            '$ CainFlow browser-backend --status',
            '',
            f'  状态       : RUNNING',
            f'  版本       : {self.version}',
            f'  本地地址   : {self.url}',
            f'  监听       : {self.host}:{self.port}（仅本机）',
            f'  端口模式   : {port_mode}',
            f'  启动时间   : {self.started_at:%Y-%m-%d %H:%M:%S}',
            f'  运行时长   : {hours:02d}:{minutes:02d}:{seconds:02d}',
            '',
            f'  数据目录   : {self.data_dir}',
            f'  SQLite     : {self.database_path}',
            f'  工作流目录 : {self.workflows_dir}',
            f'  导出目录   : {self.exports_dir}',
            f'  日志目录   : {self.log_dir}',
        ]
        if self.webview_reason:
            lines.extend(('', f'  WebView2   : {self.webview_reason}'))
        if self.port_fallback_reason:
            lines.append(f'  端口回退   : {self.port_fallback_reason}')
        lines.extend(('', '--- 服务事件（不包含请求正文、响应正文或 API Key）---'))
        lines.extend(self.event_lines())
        return '\n'.join(lines)


def _run_task_dialog_fallback(status, reopen_browser, on_stop_requested):
    while show_browser_mode_status(status.url) == BROWSER_STATUS_REOPEN:
        reopen_browser()
    on_stop_requested()


def _run_winforms_status_window(status, reopen_browser, open_log_directory, on_stop_requested):
    try:
        import clr
    except Exception:
        os.environ.setdefault('PYTHONNET_RUNTIME', 'coreclr')
        import clr

    clr.AddReference('System.Windows.Forms')
    clr.AddReference('System.Drawing')

    import System.Drawing as Drawing
    import System.Windows.Forms as Forms

    Forms.Application.EnableVisualStyles()
    form = Forms.Form()
    form.Text = 'CainFlow 浏览器模式后端'
    form.ClientSize = Drawing.Size(800, 520)
    form.MinimumSize = Drawing.Size(720, 460)
    form.StartPosition = Forms.FormStartPosition.CenterScreen
    form.BackColor = Drawing.Color.FromArgb(18, 20, 24)

    output = Forms.RichTextBox()
    output.Dock = Forms.DockStyle.Fill
    output.ReadOnly = True
    output.BorderStyle = getattr(Forms.BorderStyle, 'None')
    output.BackColor = Drawing.Color.FromArgb(18, 20, 24)
    output.ForeColor = Drawing.Color.FromArgb(164, 255, 185)
    output.Font = Drawing.Font('Consolas', 10.0)
    output.WordWrap = False
    output.DetectUrls = False
    output.Text = status.render_terminal_text()

    buttons = Forms.FlowLayoutPanel()
    buttons.Dock = Forms.DockStyle.Bottom
    buttons.Height = 52
    buttons.Padding = Forms.Padding(10, 9, 10, 8)
    buttons.FlowDirection = Forms.FlowDirection.LeftToRight
    buttons.WrapContents = False
    buttons.BackColor = Drawing.Color.FromArgb(28, 31, 37)

    def make_button(label, width=132):
        button = Forms.Button()
        button.Text = label
        button.Width = width
        button.Height = 30
        button.FlatStyle = Forms.FlatStyle.Flat
        button.BackColor = Drawing.Color.FromArgb(43, 48, 57)
        button.ForeColor = Drawing.Color.White
        button.FlatAppearance.BorderColor = Drawing.Color.FromArgb(75, 82, 94)
        return button

    reopen_button = make_button('重新打开浏览器')
    copy_button = make_button('复制地址', 100)
    log_button = make_button('打开日志目录', 120)
    stop_button = make_button('停止服务并退出', 132)

    def refresh_output(*_args):
        text = status.render_terminal_text()
        if output.Text != text:
            output.Text = text
            output.SelectionStart = len(output.Text)
            output.ScrollToCaret()

    def reopen_clicked(*_args):
        reopen_browser()
        refresh_output()

    def copy_clicked(*_args):
        try:
            Forms.Clipboard.SetText(status.url)
            status.add_event('本地地址已复制到剪贴板')
        except Exception as error:
            status.add_event(f'复制地址失败：{error}')
        refresh_output()

    def log_clicked(*_args):
        try:
            open_log_directory()
            status.add_event('已打开日志目录')
        except Exception as error:
            status.add_event(f'打开日志目录失败：{error}')
        refresh_output()

    stopping = {'requested': False}

    def notify_stop_requested():
        if not stopping['requested']:
            stopping['requested'] = True
            status.add_event('正在停止 CainFlow 服务')
            on_stop_requested()

    def stop_clicked(*_args):
        notify_stop_requested()
        form.Close()

    def form_closing(*_args):
        notify_stop_requested()

    reopen_button.Click += reopen_clicked
    copy_button.Click += copy_clicked
    log_button.Click += log_clicked
    stop_button.Click += stop_clicked
    form.FormClosing += form_closing

    buttons.Controls.Add(reopen_button)
    buttons.Controls.Add(copy_button)
    buttons.Controls.Add(log_button)
    buttons.Controls.Add(stop_button)
    form.Controls.Add(output)
    form.Controls.Add(buttons)

    timer = Forms.Timer()
    timer.Interval = 1000
    timer.Tick += refresh_output
    timer.Start()
    try:
        Forms.Application.Run(form)
    finally:
        timer.Stop()
        timer.Dispose()


def show_browser_service_window(
    status,
    reopen_browser,
    open_log_directory,
    on_stop_requested=lambda: None,
    winforms_runner=None,
    fallback_runner=None,
):
    fallback = fallback_runner or _run_task_dialog_fallback
    if sys.platform != 'win32':
        fallback(status, reopen_browser, on_stop_requested)
        return
    try:
        runner = winforms_runner or _run_winforms_status_window
        runner(status, reopen_browser, open_log_directory, on_stop_requested)
    except Exception as error:
        status.add_event(f'终端状态窗口启动失败，已切换到简易窗口：{error}')
        fallback(status, reopen_browser, on_stop_requested)
