import ctypes
import sys
from ctypes import wintypes


TASKBAR_STATUS_COMPLETED = 'completed'
TASKBAR_STATUS_FAILED = 'failed'
TASKBAR_STATUSES = {TASKBAR_STATUS_COMPLETED, TASKBAR_STATUS_FAILED}


class GUID(ctypes.Structure):
    _fields_ = (
        ('Data1', ctypes.c_ulong),
        ('Data2', ctypes.c_ushort),
        ('Data3', ctypes.c_ushort),
        ('Data4', ctypes.c_ubyte * 8),
    )

    @classmethod
    def from_string(cls, value):
        import uuid
        parsed = uuid.UUID(value)
        return cls.from_buffer_copy(parsed.bytes_le)


class WindowsTaskbarAdapter:
    _CLSID_TASKBAR_LIST = GUID.from_string('56FDF344-FD6D-11D0-958A-006097C9A090')
    _IID_TASKBAR_LIST3 = GUID.from_string('EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF')
    _CLSCTX_INPROC_SERVER = 1

    def set_overlay(self, hwnd, status):
        ole32 = ctypes.windll.ole32
        user32 = ctypes.windll.user32
        initialized = ole32.CoInitializeEx(None, 2) >= 0
        interface = ctypes.c_void_p()
        icon = None
        try:
            result = ole32.CoCreateInstance(
                ctypes.byref(self._CLSID_TASKBAR_LIST),
                None,
                self._CLSCTX_INPROC_SERVER,
                ctypes.byref(self._IID_TASKBAR_LIST3),
                ctypes.byref(interface),
            )
            if result < 0:
                raise OSError(f'CoCreateInstance failed: HRESULT 0x{result & 0xFFFFFFFF:08X}')

            vtable = ctypes.cast(interface, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            hr_init = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(vtable[3])
            set_overlay_icon = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, wintypes.HWND, wintypes.HICON, wintypes.LPCWSTR
            )(vtable[18])
            release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])
            try:
                result = hr_init(interface)
                if result < 0:
                    raise OSError(f'ITaskbarList3.HrInit failed: HRESULT 0x{result & 0xFFFFFFFF:08X}')
                description = None
                if status:
                    icon = self._create_status_icon(status)
                    description = 'CainFlow 运行完成' if status == TASKBAR_STATUS_COMPLETED else 'CainFlow 运行失败'
                result = set_overlay_icon(interface, hwnd, icon or 0, description)
                if result < 0:
                    raise OSError(f'SetOverlayIcon failed: HRESULT 0x{result & 0xFFFFFFFF:08X}')
            finally:
                release(interface)
        finally:
            if icon:
                user32.DestroyIcon(icon)
            if initialized:
                ole32.CoUninitialize()

    @staticmethod
    def _build_status_pixels(status):
        size = 16
        success = status == TASKBAR_STATUS_COMPLETED
        pixels = bytearray(size * size * 4)
        center = 7.5
        for y in range(size):
            for x in range(size):
                distance = ((x - center) ** 2 + (y - center) ** 2) ** 0.5
                if distance <= 7:
                    blue, green, red = ((52, 168, 52) if success else (55, 72, 220))
                    offset = (y * size + x) * 4
                    pixels[offset:offset + 4] = bytes((blue, green, red, 255))

        def paint(x, y):
            if 0 <= x < size and 0 <= y < size:
                offset = (y * size + x) * 4
                pixels[offset:offset + 4] = b'\xff\xff\xff\xff'

        if success:
            for x, y in ((4, 8), (5, 9), (6, 10), (7, 9), (8, 8), (9, 7), (10, 6), (11, 5)):
                paint(x, y)
                paint(x, y + 1)
        else:
            for y in range(4, 10):
                paint(7, y)
                paint(8, y)
            paint(7, 12)
            paint(8, 12)

        return pixels

    @staticmethod
    def _create_status_icon(status):
        size = 16
        pixels = WindowsTaskbarAdapter._build_status_pixels(status)

        and_mask = (ctypes.c_ubyte * (size * size // 8))()
        xor_mask = (ctypes.c_ubyte * len(pixels)).from_buffer_copy(pixels)
        create_icon = ctypes.windll.user32.CreateIcon
        create_icon.argtypes = (
            wintypes.HINSTANCE,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_ubyte,
            ctypes.c_ubyte,
            ctypes.c_void_p,
            ctypes.c_void_p,
        )
        create_icon.restype = wintypes.HICON
        icon = create_icon(None, size, size, 1, 32, and_mask, xor_mask)
        if not icon:
            raise ctypes.WinError()
        return icon


class WindowsTaskbarService:
    def __init__(self, platform=None, adapter=None):
        self._platform = platform or sys.platform
        self._adapter = adapter or WindowsTaskbarAdapter()
        self._window = None

    def attach_window(self, window):
        self._window = window

    def set_status(self, status):
        if status not in TASKBAR_STATUSES:
            raise ValueError('Unsupported taskbar status')
        return self._apply(status)

    def clear(self):
        return self._apply(None)

    def _apply(self, status):
        if self._platform != 'win32' or not self._window:
            return False
        native = getattr(self._window, 'native', None)
        handle = getattr(native, 'Handle', None)
        if handle is None:
            return False
        if hasattr(handle, 'ToInt64'):
            hwnd = handle.ToInt64()
        elif hasattr(handle, 'ToInt32'):
            hwnd = handle.ToInt32()
        else:
            hwnd = int(handle)
        if not hwnd:
            return False
        self._adapter.set_overlay(hwnd, status)
        return True
