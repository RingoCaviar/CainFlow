import base64
import os
import subprocess
import sys


MAX_NOTIFICATION_TITLE_LENGTH = 120
MAX_NOTIFICATION_BODY_LENGTH = 500
MAX_NOTIFICATION_TAG_LENGTH = 80
NOTIFICATION_TIMEOUT_SECONDS = 8


_WINDOWS_TOAST_SCRIPT = r'''
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$textNodes = $xml.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($xml.CreateTextNode($env:CAINFLOW_TOAST_TITLE)) > $null
$textNodes.Item(1).AppendChild($xml.CreateTextNode($env:CAINFLOW_TOAST_BODY)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $env:CAINFLOW_TOAST_TAG
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CainFlow').Show($toast)
'''


def _normalize_text(value, max_length):
    text = str(value or '').strip()
    if len(text) > max_length:
        raise ValueError(f'Notification text exceeds {max_length} characters')
    return text


def normalize_notification_payload(title, body='', tag=''):
    normalized_title = _normalize_text(title, MAX_NOTIFICATION_TITLE_LENGTH)
    if not normalized_title:
        raise ValueError('Notification title is required')
    return {
        'title': normalized_title,
        'body': _normalize_text(body, MAX_NOTIFICATION_BODY_LENGTH),
        'tag': _normalize_text(tag, MAX_NOTIFICATION_TAG_LENGTH) or 'cainflow-workflow-run',
    }


def _powershell_command():
    encoded = base64.b64encode(_WINDOWS_TOAST_SCRIPT.encode('utf-16-le')).decode('ascii')
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]


def send_system_notification(title, body='', tag='', *, platform=None, run=None):
    current_platform = platform or sys.platform
    if current_platform != 'win32':
        return {'success': False, 'channel': 'unsupported'}

    try:
        payload = normalize_notification_payload(title, body, tag)
    except ValueError as error:
        return {'success': False, 'channel': 'windows-native', 'error': str(error)}

    env = os.environ.copy()
    env.update({
        'CAINFLOW_TOAST_TITLE': payload['title'],
        'CAINFLOW_TOAST_BODY': payload['body'],
        'CAINFLOW_TOAST_TAG': payload['tag'],
    })
    startupinfo = None
    creationflags = 0
    if os.name == 'nt':
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

    run_command = run or subprocess.run
    try:
        result = run_command(
            _powershell_command(),
            env=env,
            capture_output=True,
            text=True,
            timeout=NOTIFICATION_TIMEOUT_SECONDS,
            check=False,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {'success': False, 'channel': 'windows-native', 'error': str(error)}

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or 'Windows notification command failed').strip()
        return {'success': False, 'channel': 'windows-native', 'error': detail[-500:]}
    return {'success': True, 'channel': 'windows-native'}


"""Platform-specific system notification delivery."""
