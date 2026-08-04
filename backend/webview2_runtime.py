import ctypes
import os
import platform
import struct
import sys
from dataclasses import dataclass
from typing import Optional


WEBVIEW2_STATUS_AVAILABLE = 'available'
WEBVIEW2_STATUS_MISSING = 'missing'
WEBVIEW2_STATUS_INVALID = 'invalid'

WEBVIEW2_INIT_PENDING = 'pending'
WEBVIEW2_INIT_SUCCESS = 'success'
WEBVIEW2_INIT_FAILED = 'failed'

_RUNTIME_NOT_FOUND_HRESULTS = {
    0x80070002,  # ERROR_FILE_NOT_FOUND
    0x8007007E,  # ERROR_MOD_NOT_FOUND
}


@dataclass(frozen=True)
class WebView2RuntimeStatus:
    status: str
    version: str = ''
    reason: str = ''
    hresult: Optional[int] = None
    loader_path: str = ''

    @property
    def available(self):
        return self.status == WEBVIEW2_STATUS_AVAILABLE


@dataclass
class WebView2InitializationResult:
    status: str = WEBVIEW2_INIT_PENDING
    error: str = ''


def _is_valid_version(value):
    version = str(value or '').strip()
    if not version:
        return False
    parts = version.split('.')
    return all(part.isdigit() for part in parts) and any(int(part) > 0 for part in parts)


def _runtime_platform_directory():
    machine = platform.machine().lower()
    if machine in ('arm64', 'aarch64'):
        return 'win-arm64'
    return 'win-x64' if struct.calcsize('P') == 8 else 'win-x86'


def resolve_webview2_loader_path(webview_module):
    from webview.util import interop_dll_path

    runtime_directory = interop_dll_path(_runtime_platform_directory())
    return os.path.join(runtime_directory, 'WebView2Loader.dll')


def query_webview2_loader(loader_path, dll_loader=None, memory_free=None):
    if dll_loader is None:
        dll_loader = ctypes.WinDLL
    loader = dll_loader(loader_path)
    query = loader.GetAvailableCoreWebView2BrowserVersionString
    query.argtypes = (ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p))
    query.restype = ctypes.c_long

    version_pointer = ctypes.c_void_p()
    hresult = int(query(None, ctypes.byref(version_pointer)))
    normalized_hresult = hresult & 0xFFFFFFFF
    try:
        version = ctypes.wstring_at(version_pointer.value) if version_pointer.value else ''
    finally:
        if version_pointer.value:
            if memory_free is None:
                memory_free = ctypes.windll.ole32.CoTaskMemFree
                memory_free.argtypes = (ctypes.c_void_p,)
                memory_free.restype = None
            memory_free(version_pointer)
    return normalized_hresult, version


def detect_webview2_runtime(webview_module=None, loader_path=None, version_query=None):
    if sys.platform != 'win32':
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_AVAILABLE, reason='system-webview')

    try:
        if loader_path:
            resolved_path = loader_path
        else:
            if webview_module is None:
                import webview as webview_module
            resolved_path = resolve_webview2_loader_path(webview_module)
    except Exception as error:
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_INVALID, reason=str(error))

    if not os.path.isfile(resolved_path):
        return WebView2RuntimeStatus(
            WEBVIEW2_STATUS_MISSING,
            reason='未找到 WebView2Loader.dll',
            loader_path=resolved_path,
        )

    try:
        query = version_query or query_webview2_loader
        hresult, version = query(resolved_path)
    except OSError as error:
        status = WEBVIEW2_STATUS_MISSING if getattr(error, 'winerror', None) in (2, 126) else WEBVIEW2_STATUS_INVALID
        return WebView2RuntimeStatus(status, reason=str(error), loader_path=resolved_path)
    except Exception as error:
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_INVALID, reason=str(error), loader_path=resolved_path)

    if hresult != 0:
        status = WEBVIEW2_STATUS_MISSING if hresult in _RUNTIME_NOT_FOUND_HRESULTS else WEBVIEW2_STATUS_INVALID
        return WebView2RuntimeStatus(
            status,
            reason=f'WebView2 Loader 探测失败：HRESULT 0x{hresult:08X}',
            hresult=hresult,
            loader_path=resolved_path,
        )
    if not _is_valid_version(version):
        return WebView2RuntimeStatus(
            WEBVIEW2_STATUS_INVALID,
            reason='WebView2 Loader 返回了无效版本',
            hresult=hresult,
            loader_path=resolved_path,
        )
    return WebView2RuntimeStatus(
        WEBVIEW2_STATUS_AVAILABLE,
        version=str(version).strip(),
        hresult=hresult,
        loader_path=resolved_path,
    )


def install_webview2_initialization_hook(result, edge_module=None):
    if edge_module is None:
        from webview.platforms import edgechromium as edge_module

    edge_class = edge_module.EdgeChrome
    original_handler = edge_class.on_webview_ready

    def monitored_handler(instance, sender, args):
        if bool(args.IsSuccess):
            result.status = WEBVIEW2_INIT_SUCCESS
            result.error = ''
            return original_handler(instance, sender, args)

        result.status = WEBVIEW2_INIT_FAILED
        result.error = str(args.InitializationException or 'WebView2 初始化失败')
        original_handler(instance, sender, args)
        try:
            instance.form.Close()
        except Exception:
            pass

    edge_class.on_webview_ready = monitored_handler

    def restore():
        if edge_class.on_webview_ready is monitored_handler:
            edge_class.on_webview_ready = original_handler

    return restore
