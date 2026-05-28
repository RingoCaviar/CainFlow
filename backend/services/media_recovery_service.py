import json
import re


_DATA_URL_RE = re.compile(
    r'data:(image/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)',
    re.IGNORECASE,
)
_FIELD_RE_TEMPLATE = r'"{name}"\s*:\s*"([^"]+)"'
_BASE64_RE = re.compile(r'^[A-Za-z0-9+/=\s]{128,}$')


def _decode_json_string(value):
    try:
        return json.loads(f'"{value}"')
    except Exception:
        return str(value or '').replace('\\/', '/')


def _normalize_base64(value):
    return re.sub(r'\s+', '', _decode_json_string(value or ''))


def _guess_image_mime(data):
    compact = _normalize_base64(data)
    if compact.startswith('/9j/'):
        return 'image/jpeg'
    if compact.startswith('iVBORw0KGgo'):
        return 'image/png'
    if compact.startswith('UklGR'):
        return 'image/webp'
    if compact.startswith('R0lGOD'):
        return 'image/gif'
    return 'image/png'


def _looks_like_image_base64(data):
    compact = _normalize_base64(data)
    if len(compact) < 128 or not _BASE64_RE.match(compact):
        return False
    return compact.startswith(('/9j/', 'iVBORw0KGgo', 'UklGR', 'R0lGOD'))


def _build_result(data, mime_type='', source='unknown'):
    normalized_data = _normalize_base64(data)
    if not normalized_data:
        return None
    normalized_mime = str(mime_type or '').strip() or _guess_image_mime(normalized_data)
    if not normalized_mime.lower().startswith('image/'):
        normalized_mime = _guess_image_mime(normalized_data)
    return {
        'dataUrl': f'data:{normalized_mime};base64,{normalized_data}',
        'mimeType': normalized_mime,
        'source': source,
        'bytesApprox': max(0, (len(normalized_data) * 3) // 4),
    }


def _extract_from_json_value(value):
    if isinstance(value, dict):
        inline_data = value.get('inlineData') or value.get('inline_data')
        if isinstance(inline_data, dict) and inline_data.get('data'):
            result = _build_result(
                inline_data.get('data'),
                inline_data.get('mimeType') or inline_data.get('mime_type'),
                'gemini_inline_data',
            )
            if result:
                return result

        for key in ('b64_json', 'b64Json', 'base64', 'image_base64'):
            if isinstance(value.get(key), str) and _looks_like_image_base64(value.get(key)):
                result = _build_result(value.get(key), value.get('mimeType') or value.get('mime_type'), key)
                if result:
                    return result

        for item in value.values():
            result = _extract_from_json_value(item)
            if result:
                return result

    if isinstance(value, list):
        for item in value:
            result = _extract_from_json_value(item)
            if result:
                return result

    return None


def _find_balanced_json(text):
    source = str(text or '')
    starts = [index for index in (source.find('{'), source.find('[')) if index >= 0]
    if not starts:
        return ''
    start = min(starts)
    stack = []
    in_string = False
    escaped = False

    for index in range(start, len(source)):
        char = source[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == '{':
            stack.append('}')
        elif char == '[':
            stack.append(']')
        elif char in ('}', ']'):
            if not stack or stack.pop() != char:
                return ''
            if not stack:
                return source[start:index + 1]
    return ''


def _recover_from_json(text):
    for candidate in (str(text or ''), _find_balanced_json(text)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        result = _extract_from_json_value(parsed)
        if result:
            return result
    return None


def _recover_data_url(text):
    match = _DATA_URL_RE.search(str(text or ''))
    if not match:
        return None
    return _build_result(match.group(2), match.group(1), 'data_url')


def _recover_from_field_patterns(text):
    source = str(text or '')
    inline_index = -1
    for marker in ('"inlineData"', '"inline_data"'):
        index = source.find(marker)
        if index >= 0 and (inline_index < 0 or index < inline_index):
            inline_index = index
    segment = source[inline_index:] if inline_index >= 0 else source

    data_match = re.search(_FIELD_RE_TEMPLATE.format(name='data'), segment, re.IGNORECASE | re.DOTALL)
    if not data_match:
        for name in ('b64_json', 'b64Json', 'base64', 'image_base64'):
            data_match = re.search(_FIELD_RE_TEMPLATE.format(name=name), segment, re.IGNORECASE | re.DOTALL)
            if data_match:
                break
    if not data_match:
        return None

    data = data_match.group(1)
    if not _looks_like_image_base64(data):
        return None

    mime_match = (
        re.search(_FIELD_RE_TEMPLATE.format(name='mimeType'), segment, re.IGNORECASE | re.DOTALL)
        or re.search(_FIELD_RE_TEMPLATE.format(name='mime_type'), segment, re.IGNORECASE | re.DOTALL)
    )
    return _build_result(data, _decode_json_string(mime_match.group(1)) if mime_match else '', 'field_pattern')


def recover_image_from_response_text(text, content_type=''):
    raw_text = str(text or '')
    if not raw_text.strip():
        return {
            'success': False,
            'attempted': True,
            'error': 'empty_response',
            'message': '媒体恢复模块已尝试解析响应内容，但响应为空，未发现可用媒体数据。',
            'contentType': str(content_type or ''),
        }

    result = _recover_from_json(raw_text) or _recover_data_url(raw_text) or _recover_from_field_patterns(raw_text)
    if not result:
        return {
            'success': False,
            'attempted': True,
            'error': 'no_image_data_found',
            'message': '媒体恢复模块已尝试解析响应内容，但未发现可用的图片或媒体数据。',
            'contentType': str(content_type or ''),
        }

    return {
        'success': True,
        'attempted': True,
        'image': result,
        'contentType': str(content_type or ''),
    }
