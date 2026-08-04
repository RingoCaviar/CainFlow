import ctypes
import sys


WEBVIEW_CHOICE_BROWSER = 'browser'
WEBVIEW_CHOICE_INSTALL = 'install'
WEBVIEW_CHOICE_EXIT = 'exit'

BROWSER_STATUS_REOPEN = 'reopen'
BROWSER_STATUS_STOP = 'stop'

PORT_CHOICE_RANDOM = 'random'
PORT_CHOICE_EXIT = 'exit'


class _TaskDialogButton(ctypes.Structure):
    _fields_ = [
        ('nButtonID', ctypes.c_int),
        ('pszButtonText', ctypes.c_wchar_p),
    ]


class _TaskDialogConfig(ctypes.Structure):
    _fields_ = [
        ('cbSize', ctypes.c_uint),
        ('hwndParent', ctypes.c_void_p),
        ('hInstance', ctypes.c_void_p),
        ('dwFlags', ctypes.c_uint),
        ('dwCommonButtons', ctypes.c_uint),
        ('pszWindowTitle', ctypes.c_wchar_p),
        ('hMainIcon', ctypes.c_void_p),
        ('pszMainInstruction', ctypes.c_wchar_p),
        ('pszContent', ctypes.c_wchar_p),
        ('cButtons', ctypes.c_uint),
        ('pButtons', ctypes.POINTER(_TaskDialogButton)),
        ('nDefaultButton', ctypes.c_int),
        ('cRadioButtons', ctypes.c_uint),
        ('pRadioButtons', ctypes.c_void_p),
        ('nDefaultRadioButton', ctypes.c_int),
        ('pszVerificationText', ctypes.c_wchar_p),
        ('pszExpandedInformation', ctypes.c_wchar_p),
        ('pszExpandedControlText', ctypes.c_wchar_p),
        ('pszCollapsedControlText', ctypes.c_wchar_p),
        ('hFooterIcon', ctypes.c_void_p),
        ('pszFooter', ctypes.c_wchar_p),
        ('pfCallback', ctypes.c_void_p),
        ('lpCallbackData', ctypes.c_longlong),
        ('cxWidth', ctypes.c_uint),
    ]


def _show_windows_task_dialog(title, instruction, content, buttons, default_button):
    button_array = (_TaskDialogButton * len(buttons))(
        *(_TaskDialogButton(button_id, label) for button_id, label in buttons)
    )
    config = _TaskDialogConfig()
    config.cbSize = ctypes.sizeof(_TaskDialogConfig)
    config.dwFlags = 0x0008 | 0x01000000  # allow cancellation, size to content
    config.pszWindowTitle = title
    config.pszMainInstruction = instruction
    config.pszContent = content
    config.cButtons = len(buttons)
    config.pButtons = button_array
    config.nDefaultButton = default_button
    selected_button = ctypes.c_int()
    task_dialog = ctypes.windll.comctl32.TaskDialogIndirect
    task_dialog.argtypes = [
        ctypes.POINTER(_TaskDialogConfig),
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    task_dialog.restype = ctypes.c_long
    result = task_dialog(ctypes.byref(config), ctypes.byref(selected_button), None, None)
    if result != 0:
        raise OSError(f'TaskDialogIndirect failed: HRESULT 0x{result & 0xFFFFFFFF:08X}')
    return selected_button.value


def choose_webview_missing_action():
    if sys.platform != 'win32':
        return WEBVIEW_CHOICE_EXIT
    buttons = (
        (101, '使用浏览器模式'),
        (102, '打开 WebView2 官方安装页面'),
        (103, '退出'),
    )
    try:
        selected = _show_windows_task_dialog(
            'CainFlow 启动方式',
            '未检测到 Microsoft Edge WebView2 Runtime',
            'CainFlow 可以临时在系统浏览器中运行，也可以前往微软官网下载并安装 WebView2。',
            buttons,
            101,
        )
    except Exception:
        message = (
            '未检测到 Microsoft Edge WebView2 Runtime。\n\n'
            '“是”：使用浏览器模式\n'
            '“否”：打开 WebView2 官方安装页面\n'
            '“取消”：退出'
        )
        selected = ctypes.windll.user32.MessageBoxW(None, message, 'CainFlow 启动方式', 0x23)
        return {6: WEBVIEW_CHOICE_BROWSER, 7: WEBVIEW_CHOICE_INSTALL}.get(selected, WEBVIEW_CHOICE_EXIT)
    return {
        101: WEBVIEW_CHOICE_BROWSER,
        102: WEBVIEW_CHOICE_INSTALL,
        103: WEBVIEW_CHOICE_EXIT,
    }.get(selected, WEBVIEW_CHOICE_EXIT)


def show_browser_mode_status(url):
    if sys.platform != 'win32':
        return BROWSER_STATUS_STOP
    try:
        selected = _show_windows_task_dialog(
            'CainFlow 浏览器模式',
            'CainFlow 浏览器模式正在运行',
            f'本地地址：{url}\n\n关闭此窗口将停止 CainFlow 服务。',
            ((201, '重新打开浏览器'), (202, '停止服务并退出')),
            202,
        )
    except Exception:
        message = f'CainFlow 浏览器模式正在运行：\n{url}\n\n点击“确定”停止服务并退出。'
        ctypes.windll.user32.MessageBoxW(None, message, 'CainFlow 浏览器模式', 0x40)
        return BROWSER_STATUS_STOP
    return BROWSER_STATUS_REOPEN if selected == 201 else BROWSER_STATUS_STOP


def choose_random_port_action(preferred_port, error_message=''):
    if sys.platform != 'win32':
        return PORT_CHOICE_EXIT
    detail = f'端口 {preferred_port} 当前无法使用。'
    if error_message:
        detail += f'\n\n原因：{error_message}'
    detail += '\n\n是否改用系统随机分配的本地端口？'
    try:
        selected = _show_windows_task_dialog(
            'CainFlow 端口不可用',
            f'无法使用首选端口 {preferred_port}',
            detail,
            ((301, '使用随机端口'), (302, '退出')),
            301,
        )
    except Exception:
        selected = ctypes.windll.user32.MessageBoxW(
            None,
            f'{detail}\n\n选择“是”使用随机端口，选择“否”退出。',
            'CainFlow 端口不可用',
            0x24,
        )
        return PORT_CHOICE_RANDOM if selected == 6 else PORT_CHOICE_EXIT
    return PORT_CHOICE_RANDOM if selected == 301 else PORT_CHOICE_EXIT
