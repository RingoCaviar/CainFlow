"""Validate static vector images while retaining their original UTF-8 bytes."""

import re
from xml.parsers import expat


SVG_MIME = 'image/svg+xml'
_SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
_XLINK_HREF = 'http://www.w3.org/1999/xlink href'
_DRAWING_ELEMENTS = frozenset('''svg g defs title desc symbol use path rect circle ellipse line polyline polygon
    text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker filter feBlend feColorMatrix
    feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow
    feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight
    feSpecularLighting feSpotLight feTile feTurbulence'''.split())
_PAINT_REFERENCES = frozenset('fill stroke clip-path mask filter marker marker-start marker-mid marker-end cursor'.split())
_INLINE_STYLES = _PAINT_REFERENCES | frozenset('''color opacity fill-opacity fill-rule stroke-opacity stroke-width
    stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stop-color stop-opacity
    flood-color flood-opacity lighting-color paint-order clip-rule display visibility transform transform-origin
    font-family font-size font-style font-weight letter-spacing word-spacing text-anchor dominant-baseline'''.split())
_FRAGMENT = re.compile(r'#[\w.:-]+')
_LOCAL_URL = re.compile(r'''\burl\(\s*(['"]?)#[\w.:-]+\1\s*\)''', re.IGNORECASE)
_UNSAFE_CSS = re.compile(r'\\|/\*|@|\b(?:url|image|(?:-webkit-)?image-set|src)\s*\(', re.IGNORECASE)


def is_svg_mime(mime):
    return str(mime or '').split(';', 1)[0].strip().lower() == SVG_MIME


def _reject(*_):
    raise ValueError('SVG 必须是没有脚本、动画、内嵌图片或外部资源的静态矢量图')


def _validate_paint(value):
    if _UNSAFE_CSS.search(_LOCAL_URL.sub('', value)):
        _reject()


def _validate_style(value):
    for declaration in filter(None, map(str.strip, value.split(';'))):
        name, _, paint = declaration.partition(':')
        if name.strip().lower() not in _INLINE_STYLES or not paint.strip():
            _reject()
        _validate_paint(paint)


def validate_static_svg(body):
    root_seen = False

    def xml_declaration(_version, encoding, _standalone):
        if encoding and encoding.lower() != 'utf-8':
            _reject()

    def start_element(name, attributes):
        nonlocal root_seen
        namespace, _, tag = name.partition(' ')
        if namespace != _SVG_NAMESPACE or tag not in _DRAWING_ELEMENTS or (not root_seen and tag != 'svg'):
            _reject()
        root_seen = True
        for attribute, value in attributes.items():
            if attribute.lower().startswith('on') or attribute == 'http://www.w3.org/XML/1998/namespace base':
                _reject()
            if attribute in ('href', _XLINK_HREF) and not _FRAGMENT.fullmatch(value.strip()):
                _reject()
            if attribute in _PAINT_REFERENCES:
                _validate_paint(value)
            if attribute == 'style':
                _validate_style(value)

    try:
        text = body.decode('utf-8-sig')
        parser = expat.ParserCreate(namespace_separator=' ')
        parser.StartElementHandler = start_element
        parser.XmlDeclHandler = xml_declaration
        parser.StartDoctypeDeclHandler = _reject
        parser.ProcessingInstructionHandler = _reject
        parser.Parse(text, True)
    except (expat.ExpatError, UnicodeDecodeError) as error:
        raise ValueError('无法读取 SVG 图片，必须使用有效的 UTF-8 SVG 文档') from error
