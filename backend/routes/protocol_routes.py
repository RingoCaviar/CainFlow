"""
协议文件管理路由
"""
import json
import os
import re
import shutil
import tempfile
import copy
from urllib.parse import unquote

from backend import config
from backend.services.http_helpers import write_error, write_json, write_text


EXCLUDED_PROTOCOL_FILES = {'index.js', 'base-protocol.js', 'request-builder.js'}
BUILT_IN_PROTOCOL_IDS = {
    'google', 'openai', 'ttapi', 'ttapi-openai', 'newapi-image-async',
    'veo-unified', 'veo-openai', 'doubao-video', 'api6789-seedance',
    'async-video-api', 'relay-video', 'agnesimage'
}
OVERRIDE_FILE_NAME = 'protocol-overrides.json'


def get_override_file_path():
    return os.path.join(config.DATA_DIR, OVERRIDE_FILE_NAME)


def load_protocol_overrides():
    try:
        with open(get_override_file_path(), 'r', encoding='utf-8') as source:
            data = json.load(source)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        # A malformed override file must not prevent the built-in baseline from
        # loading. Keep the file for recovery and expose an empty set instead.
        return {}


def save_protocol_overrides(overrides):
    target_path = get_override_file_path()
    directory = os.path.dirname(target_path)
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix='protocol-overrides-', dir=directory)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(overrides, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        if os.path.exists(target_path):
            shutil.copy2(target_path, f'{target_path}.bak')
        os.replace(temporary_path, target_path)
        temporary_path = None
        try:
            directory_descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.remove(temporary_path)


def get_static_protocol_dir():
    return os.path.join(config.STATIC_ROOT, 'js', 'features', 'execution', 'protocols')


def get_user_protocol_dir():
    import sys
    if not hasattr(sys, 'frozen'):
        return os.path.join(config.PROJECT_ROOT, 'protocols_dev_ignored')
    return config.PROTOCOLS_DIR


def get_save_protocol_dir():
    """获取协议保存目录。开发模式下直接保存到静态文件目录，打包模式下保存到用户协议目录。"""
    import sys
    if not hasattr(sys, 'frozen'):
        return get_static_protocol_dir()
    return get_user_protocol_dir()


def list_protocol_ids(protocol_dir):
    if not os.path.exists(protocol_dir):
        return []
    protocol_ids = []
    for filename in os.listdir(protocol_dir):
        if filename.endswith('.js') and filename not in EXCLUDED_PROTOCOL_FILES:
            protocol_ids.append(filename[:-3])
    return protocol_ids


def rewrite_runtime_protocol_module(content):
    """让运行目录中的协议模块仍然引用前端真实协议注册中心。"""
    return re.sub(
        r"from\s+(['\"])\./index\.js\1",
        "from '/js/features/execution/protocols/index.js'",
        content
    )


def handle_post(handler):
    """处理POST请求"""
    if handler.path == '/api/protocol/save':
        save_protocol(handler)
        return True
    if handler.path == '/api/protocol/override/import':
        import_protocol_override(handler)
        return True
    if handler.path.split('?', 1)[0] == '/api/protocol/override/restore':
        restore_protocol_override(handler)
        return True
    return False


def handle_get(handler):
    """处理GET请求"""
    if handler.path == '/api/protocol/list':
        list_protocols(handler)
        return True
    if handler.path == '/api/protocol/overrides':
        write_json(handler, {'success': True, 'overrides': load_protocol_overrides()})
        return True
    if handler.path.startswith('/api/protocol/module/'):
        serve_protocol_module(handler)
        return True
    return False


def handle_delete(handler):
    """删除一个内置协议覆盖，恢复随应用发布的基线。"""
    path = handler.path.split('?', 1)[0]
    prefix = '/api/protocol/override/'
    if not path.startswith(prefix):
        return False
    protocol_id = unquote(path[len(prefix):])
    if protocol_id not in BUILT_IN_PROTOCOL_IDS:
        write_error(handler, 400, '只有内置协议支持删除覆盖记录')
        return True
    overrides = load_protocol_overrides()
    existed = protocol_id in overrides
    overrides.pop(protocol_id, None)
    if existed:
        save_protocol_overrides(overrides)
    write_json(handler, {'success': True, 'removed': existed, 'protocolId': protocol_id})
    return True


def list_protocols(handler):
    """列出所有协议文件"""
    try:
        static_protocols = sorted(set(list_protocol_ids(get_static_protocol_dir())))
        user_protocols = sorted(set(list_protocol_ids(get_user_protocol_dir())))
        protocol_files = sorted(set(static_protocols + user_protocols))

        write_json(handler, {
            'success': True,
            'protocols': protocol_files,
            'staticProtocols': static_protocols,
            'userProtocols': user_protocols
        })

    except Exception as e:
        write_error(handler, 500, f'获取协议列表失败: {str(e)}')


def serve_protocol_module(handler):
    """读取运行目录中的协议模块，供前端动态 import。"""
    try:
        raw_name = handler.path.split('/api/protocol/module/', 1)[1].split('?', 1)[0]
        filename = unquote(raw_name)
        if not filename.endswith('.js'):
            write_error(handler, 400, '协议模块路径格式不正确')
            return

        protocol_id = filename[:-3]
        if not re.match(r'^[a-z][a-z0-9\-]*$', protocol_id):
            write_error(handler, 400, '协议ID格式不正确')
            return

        protocol_dir_abs = os.path.abspath(get_user_protocol_dir())
        file_path = os.path.abspath(os.path.join(protocol_dir_abs, f'{protocol_id}.js'))
        if os.path.commonpath([protocol_dir_abs, file_path]) != protocol_dir_abs:
            write_error(handler, 400, '协议路径不安全')
            return
        if not os.path.exists(file_path):
            write_error(handler, 404, '协议模块不存在')
            return

        with open(file_path, 'r', encoding='utf-8') as f:
            content = rewrite_runtime_protocol_module(f.read())
        write_text(
            handler,
            content,
            content_type='text/javascript; charset=utf-8'
        )
    except Exception as e:
        write_error(handler, 500, f'读取协议模块失败: {str(e)}')


def save_protocol(handler):
    """保存协议配置到文件"""
    try:
        # 读取请求体
        content_length = int(handler.headers.get('Content-Length', 0))
        body = handler.rfile.read(content_length)
        data = json.loads(body.decode('utf-8'))

        protocol_id = data.get('id')
        protocol_config = data.get('config')

        if not protocol_id or not protocol_config:
            write_error(handler, 400, '缺少必要参数')
            return

        adapter_error = validate_transport_adapters(protocol_config)
        if adapter_error:
            write_error(handler, 400, adapter_error)
            return

        # 协议ID验证
        if not re.match(r'^[a-z][a-z0-9\-]*$', protocol_id):
            write_error(handler, 400, '协议ID格式不正确')
            return

        # Built-ins keep a stable ID and immutable shipped module. Persisting
        # their edits as an independent record lets upgrades replace the
        # baseline while preserving the user's intent.
        if protocol_id in BUILT_IN_PROTOCOL_IDS:
            overrides = load_protocol_overrides()
            previous = overrides.get(protocol_id) if isinstance(overrides.get(protocol_id), dict) else {}
            revision = int(previous.get('revision') or 0) + 1
            base_schema_version = data.get('baseSchemaVersion') or protocol_config.get('baseSchemaVersion') or protocol_config.get('schemaVersion') or 1
            base_revision = data.get('baseRevision') or protocol_config.get('baseRevision') or ''
            record = {
                'formatVersion': 1,
                'protocolId': protocol_id,
                'baseSchemaVersion': int(base_schema_version),
                'baseRevision': str(base_revision),
                'revision': revision,
                'config': {**protocol_config, 'id': protocol_id},
                'updatedAt': revision,
                'source': 'user'
            }
            overrides[protocol_id] = record
            save_protocol_overrides(overrides)
            write_json(handler, {
                'success': True,
                'message': f'内置协议 {protocol_id} 的覆盖配置已保存',
                'override': record
            })
            return

        # 构建文件路径，并确保最终路径仍在协议目录内
        save_dir = get_save_protocol_dir()
        os.makedirs(save_dir, exist_ok=True)
        save_dir_abs = os.path.abspath(save_dir)
        file_path = os.path.abspath(os.path.join(save_dir_abs, f'{protocol_id}.js'))
        if os.path.commonpath([save_dir_abs, file_path]) != save_dir_abs:
            write_error(handler, 400, '协议路径不安全')
            return

        # 生成协议文件内容
        file_content = generate_protocol_file(protocol_id, protocol_config)

        # 原子替换：新内容完整落盘后才替换旧文件，并保留上一份可恢复副本。
        atomic_write_protocol(file_path, file_content)

        write_json(handler, {
            'success': True,
            'message': f'协议 {protocol_id} 已保存到文件',
            'path': file_path
        })

    except Exception as e:
        write_error(handler, 500, f'保存失败: {str(e)}')


def import_protocol_override(handler):
    """Import an override envelope through the same atomic writer."""
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        body = handler.rfile.read(content_length)
        data = json.loads(body.decode('utf-8'))
        protocol_id = str(data.get('protocolId') or data.get('id') or '').strip()
        override = data.get('override') or data.get('config')
        if protocol_id not in BUILT_IN_PROTOCOL_IDS or not isinstance(override, dict):
            write_error(handler, 400, '覆盖导入必须包含已知内置协议 ID 和 override 对象')
            return
        adapter_error = validate_transport_adapters(override)
        if adapter_error:
            write_error(handler, 400, adapter_error)
            return
        overrides = load_protocol_overrides()
        previous = overrides.get(protocol_id) if isinstance(overrides.get(protocol_id), dict) else {}
        revision = int(previous.get('revision') or 0) + 1
        record = {
            'formatVersion': 1,
            'protocolId': protocol_id,
            'baseSchemaVersion': int(data.get('baseSchemaVersion') or override.get('schemaVersion') or 1),
            'baseRevision': str(data.get('baseRevision') or ''),
            'revision': revision,
            'config': {**override, 'id': protocol_id},
            'updatedAt': revision,
            'source': 'import'
        }
        overrides[protocol_id] = record
        save_protocol_overrides(overrides)
        write_json(handler, {'success': True, 'override': record})
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        write_error(handler, 400, f'覆盖导入失败: {error}')
    except Exception as error:
        write_error(handler, 500, f'覆盖导入失败: {error}')


def restore_protocol_override(handler):
    """恢复内置协议覆盖文件中的上一份完整版本。

    ``save_protocol_overrides`` keeps a full-file ``.bak`` alongside the
    current override file.  Restoring replaces only the requested stable ID
    from that backup and writes the result through the same atomic writer.
    The writer then backs up the pre-restore state, so a second restore can
    safely toggle back if the user changes their mind.
    """
    try:
        content_length = int(handler.headers.get('Content-Length', 0))
        body = handler.rfile.read(content_length)
        data = json.loads(body.decode('utf-8'))
        protocol_id = str(data.get('protocolId') or data.get('id') or '').strip()
        if protocol_id not in BUILT_IN_PROTOCOL_IDS:
            write_error(handler, 400, '只有内置协议支持恢复覆盖版本')
            return

        backup_path = f'{get_override_file_path()}.bak'
        try:
            with open(backup_path, 'r', encoding='utf-8') as source:
                backup = json.load(source)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            write_error(handler, 404, f'内置协议 {protocol_id} 没有可恢复的覆盖版本')
            return

        previous = backup.get(protocol_id) if isinstance(backup, dict) else None
        if not isinstance(previous, dict):
            write_error(handler, 404, f'内置协议 {protocol_id} 没有可恢复的覆盖版本')
            return

        overrides = load_protocol_overrides()
        overrides[protocol_id] = copy.deepcopy(previous)
        save_protocol_overrides(overrides)
        write_json(handler, {
            'success': True,
            'protocolId': protocol_id,
            'override': overrides[protocol_id],
            'message': f'内置协议 {protocol_id} 已恢复上一份覆盖版本',
        })
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        write_error(handler, 400, f'覆盖恢复失败: {error}')
    except Exception as error:
        write_error(handler, 500, f'覆盖恢复失败: {error}')


def generate_protocol_file(protocol_id, config):
    """生成协议文件内容"""
    protocol_config = build_serializable_protocol_config(protocol_id, config)
    protocol_json = json.dumps(protocol_config, ensure_ascii=False, indent=4)

    # 生成文件内容 - 纯配置模式
    content = f"""/**
 * {protocol_config.get('label', protocol_id)} 协议插件 - 纯配置模式
 */
import {{ registerProtocol }} from './index.js';

export const {to_camel_case(protocol_id)}Protocol = {protocol_json};

registerProtocol({to_camel_case(protocol_id)}Protocol);
"""

    return content


def build_serializable_protocol_config(protocol_id, raw_config):
    """生成协议模块，同时保留编辑器尚未理解的未来字段。"""
    source = copy.deepcopy(raw_config) if isinstance(raw_config, dict) else {}
    source['id'] = protocol_id
    source['schemaVersion'] = source.get('schemaVersion') or 1
    source['label'] = source.get('label') or protocol_id
    source['taskTypes'] = source.get('taskTypes') or ['image']
    source['urlTemplate'] = source.get('urlTemplate') or '{{endpoint}}/v1/endpoint'
    source['apikeyLocation'] = source.get('apikeyLocation') or 'header'
    source['apikeyField'] = source.get('apikeyField') or 'Authorization'
    source['parameters'] = build_serializable_parameters(source.get('parameters') or {})
    source['responsePath'] = source.get('responsePath') or {
        'image': 'data[0].url',
        'chat': 'choices[0].message.content',
        'video': 'data.video_url'
    }
    source['variants'] = _normalize_serializable_variants(source.get('variants') or {})
    return source


def _normalize_serializable_variants(variants):
    if not isinstance(variants, dict):
        return variants
    normalized = copy.deepcopy(variants)
    for variant in normalized.values():
        if not isinstance(variant, dict):
            continue
        if isinstance(variant.get('parameters'), dict):
            variant['parameters'] = build_serializable_parameters(variant['parameters'])
        if isinstance(variant.get('variants'), dict):
            variant['variants'] = _normalize_serializable_variants(variant['variants'])
    return normalized


def validate_transport_adapters(protocol_config):
    """拒绝后端无法表达的 adapter 字段，避免保存时静默丢失配置。"""
    if not isinstance(protocol_config, dict):
        return '协议配置必须是对象'
    declarations = []
    nodes = [(protocol_config, None, None, None)]
    while nodes:
        node, inherited_adapter, inherited_encoding, inherited_image_encoding = nodes.pop()
        if not isinstance(node, dict):
            return '协议 variants 必须是对象映射。'
        effective_adapter = node.get('transportAdapter', inherited_adapter)
        effective_encoding = node.get('requestEncoding', inherited_encoding)
        effective_image_encoding = node.get('requestEncodingWhenReferenceImages', inherited_image_encoding)
        if 'transportAdapter' in node:
            declarations.append(node.get('transportAdapter'))
        if 'requestEncoding' in node and node.get('requestEncoding') not in (None, '', 'json', 'multipart'):
            return f'requestEncoding “{node.get("requestEncoding")}” 不受支持；当前仅支持 json 或 multipart。'
        if 'requestEncodingWhenReferenceImages' in node and node.get('requestEncodingWhenReferenceImages') not in (None, '', 'json', 'multipart'):
            return f'requestEncodingWhenReferenceImages “{node.get("requestEncodingWhenReferenceImages")}” 不受支持；当前仅支持 json 或 multipart。'
        if effective_adapter is not None:
            if isinstance(effective_adapter, str):
                effective_adapter_id = effective_adapter
            elif isinstance(effective_adapter, dict):
                effective_adapter_id = effective_adapter.get('adapterId', '')
            else:
                effective_adapter_id = ''
            if effective_encoding and effective_adapter_id in {'json', 'multipart'} and effective_encoding != effective_adapter_id:
                return f'Transport adapter “{effective_adapter_id}” 与 requestEncoding “{effective_encoding}” 冲突；请只保留一致的编码声明。'
            if effective_image_encoding and effective_adapter_id in {'json', 'multipart'} and effective_image_encoding != effective_adapter_id:
                return f'Transport adapter “{effective_adapter_id}” 与 requestEncodingWhenReferenceImages “{effective_image_encoding}” 冲突；请只保留一致的编码声明。'
        variants = node.get('variants')
        if variants is None:
            continue
        if not isinstance(variants, dict):
            return '协议 variants 必须是对象映射。'
        nodes.extend((variant, effective_adapter, effective_encoding, effective_image_encoding) for variant in variants.values())
    for declaration in declarations:
        if isinstance(declaration, str):
            adapter_id, version = declaration, 1
            keys = set()
        elif isinstance(declaration, dict):
            adapter_id = declaration.get('adapterId', '')
            version = declaration.get('version', 1)
            keys = set(declaration) - {'adapterId', 'version', 'parts'}
        else:
            return 'Transport adapter 配置必须是字符串或对象'
        if adapter_id not in {'json', 'multipart'}:
            return f'不支持 Transport adapter “{adapter_id}”，请切换到已注册的适配器。'
        try:
            if int(version) < 1 or int(version) > 1:
                return f'Transport adapter “{adapter_id}” 的版本 {version} 当前不可用。'
        except (TypeError, ValueError):
            return f'Transport adapter “{adapter_id}” 的版本无效。'
        if keys:
            return f'Transport adapter “{adapter_id}” 不支持字段 “{sorted(keys)[0]}”。'
        if isinstance(declaration, dict) and 'parts' in declaration:
            if adapter_id != 'multipart' or not isinstance(declaration['parts'], list):
                return 'multipart adapter 的 parts 必须是数组。'
            for index, part in enumerate(declaration['parts']):
                if not isinstance(part, dict):
                    return f'multipart parts[{index}] 必须是对象。'
                unsupported = set(part) - {'name', 'source', 'path', 'kind', 'repeat', 'mime', 'required', 'value'}
                if unsupported:
                    return f'multipart parts[{index}] 不支持字段 “{sorted(unsupported)[0]}”。'
                if not str(part.get('name') or '').strip():
                    return f'multipart parts[{index}] 缺少 name。'
                if part.get('source') not in {'parameter', 'media', 'literal'}:
                    return f'multipart parts[{index}] 的 source 不受支持。'
                if part.get('kind', 'text') not in {'text', 'url', 'file'}:
                    return f'multipart parts[{index}] 的 kind 不受支持。'
                if part.get('source') != 'literal' and not str(part.get('path') or '').strip():
                    return f'multipart parts[{index}] 需要 path。'
                if part.get('source') == 'literal' and 'value' not in part:
                    return f'multipart parts[{index}] 的 literal 需要 value。'
    return ''


def atomic_write_protocol(file_path, content):
    """写入临时文件、同步后替换，并保存上一版本 .bak。"""
    directory = os.path.dirname(file_path)
    temporary_path = None
    try:
        descriptor, temporary_path = tempfile.mkstemp(prefix='.cainflow-protocol-', suffix='.tmp', dir=directory)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if os.path.exists(file_path):
            shutil.copy2(file_path, f'{file_path}.bak')
        os.replace(temporary_path, file_path)
        temporary_path = None
        try:
            directory_descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
    finally:
        if temporary_path and os.path.exists(temporary_path):
            try:
                os.unlink(temporary_path)
            except OSError:
                pass


def build_serializable_parameters(parameters):
    """规范化参数 ID/label，同时保留未知字段。"""
    result = {}
    for param_id, param in parameters.items():
        if not isinstance(param, dict):
            continue
        clean_param = copy.deepcopy(param)
        clean_param['id'] = clean_param.get('id') or param_id
        clean_param['label'] = clean_param.get('label') or param_id
        result[param_id] = clean_param
    return result


def generate_parameters_code(parameters):
    """生成参数代码"""
    if not parameters:
        return ''

    params_lines = []
    for param_id, param in parameters.items():
        param_code = f"""
        {param_id}: {{
            id: '{param_id}',
            exposed: {str(param.get('exposed', True)).lower()},
            inputPort: {str(param.get('inputPort', False)).lower()},
            portType: '{param.get('portType', 'text')}',
            required: {str(param.get('required', False)).lower()},
            omitIfEmpty: {str(param.get('omitIfEmpty', True)).lower()},
            dataType: '{param.get('dataType', 'string')}',
            uiControl: '{param.get('uiControl', 'text')}',
            label: '{escape_js_string(param.get('label', param_id))}',"""

        if 'options' in param:
            options_json = json.dumps(param['options'], ensure_ascii=False, indent=20)
            param_code += f"\n            options: {options_json},"

        if 'defaultValue' in param:
            default_val = param['defaultValue']
            if isinstance(default_val, bool):
                param_code += f"\n            defaultValue: {str(default_val).lower()},"
            elif isinstance(default_val, str):
                param_code += f"\n            defaultValue: '{escape_js_string(default_val)}',"
            else:
                param_code += f"\n            defaultValue: {json.dumps(default_val)},"

        if param.get('description'):
            param_code += f"\n            description: '{escape_js_string(param['description'])}'"

        param_code += "\n        },"
        params_lines.append(param_code)

    return ''.join(params_lines)


def to_camel_case(snake_str):
    """将 kebab-case 转换为 CamelCase"""
    components = snake_str.split('-')
    return ''.join(x.title() for x in components)


def escape_js_string(s):
    """转义JavaScript字符串"""
    if not s:
        return ''
    # 先保护模板变量 {{...}}
    import re
    # 找到所有 {{...}} 模板变量
    templates = re.findall(r'\{\{[^}]+\}\}', s)
    # 用占位符替换
    temp_s = s
    placeholders = []
    for i, template in enumerate(templates):
        placeholder = f'__TEMPLATE_{i}__'
        placeholders.append((placeholder, template))
        temp_s = temp_s.replace(template, placeholder, 1)

    # 转义普通字符
    escaped = temp_s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n').replace('\r', '\\r')

    # 恢复模板变量
    for placeholder, template in placeholders:
        escaped = escaped.replace(placeholder, template)

    return escaped


"""协议文件管理路由处理器"""
