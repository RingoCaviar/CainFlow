"""Write image pixels to the Windows clipboard for the desktop WebView."""

import sys


def copy_png_to_clipboard(png_bytes):
    if sys.platform != 'win32':
        raise RuntimeError('Native image clipboard is available only on Windows')
    if not png_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Expected PNG image data')

    import clr
    clr.AddReference('System.Windows.Forms')
    clr.AddReference('System.Drawing')
    from System import Array, Byte
    from System.Drawing import Bitmap, Image
    from System.IO import MemoryStream
    from System.Threading import ApartmentState, Thread, ThreadStart
    from System.Windows.Forms import Clipboard, DataObject

    errors = []

    def write():
        stream = None
        decoded = None
        bitmap = None
        try:
            stream = MemoryStream(Array[Byte](png_bytes))
            decoded = Image.FromStream(stream)
            bitmap = Bitmap(decoded)
            data = DataObject()
            data.SetImage(bitmap)
            Clipboard.SetDataObject(data, True, 20, 100)
        except Exception as error:
            errors.append(error)
        finally:
            if bitmap is not None:
                bitmap.Dispose()
            if decoded is not None:
                decoded.Dispose()
            if stream is not None:
                stream.Dispose()

    thread = Thread(ThreadStart(write))
    thread.SetApartmentState(ApartmentState.STA)
    thread.Start()
    thread.Join()
    if errors:
        raise errors[0]
    return True
