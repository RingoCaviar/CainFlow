"""
协议文件管理路由
"""
import json
import os
import re

from backend import config
from backend.services.http_helpers import write_error, write_json


def handle_post(handler):
    """处理POST请求"""
    if handler.path == '/api/protocol/save':
        save_protocol(handler)
        return True
    return False


def handle_get(handler):
    """处理GET请求"""
    if handler.path == '/api/protocol/list':
        list_protocols(handler)
        return True
    return False


def list_protocols(handler):
    """列出所有协议文件"""
    try:
        protocol_dir = os.path.join(config.STATIC_ROOT, 'js', 'features', 'execution', 'protocols')

        if not os.path.exists(protocol_dir):
            write_json(handler, {'success': True, 'protocols': []})
            return

        # 获取所有 .js 文件（排除工具文件）
        protocol_files = []
        excluded_files = {'index.js', 'base-protocol.js', 'request-builder.js'}

        for filename in os.listdir(protocol_dir):
            if filename.endswith('.js') and filename not in excluded_files:
                protocol_id = filename[:-3]  # 移除 .js 后缀
                protocol_files.append(protocol_id)

        write_json(handler, {
            'success': True,
            'protocols': protocol_files
        })

    except Exception as e:
        write_error(handler, 500, f'获取协议列表失败: {str(e)}')


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

        # 协议ID验证
        if not re.match(r'^[a-z][a-z0-9\-]*$', protocol_id):
            write_error(handler, 400, '协议ID格式不正确')
            return

        # 构建文件路径，并确保最终路径仍在协议目录内
        protocol_dir = os.path.join(config.STATIC_ROOT, 'js', 'features', 'execution', 'protocols')
        protocol_dir_abs = os.path.abspath(protocol_dir)
        file_path = os.path.abspath(os.path.join(protocol_dir_abs, f'{protocol_id}.js'))
        if os.path.commonpath([protocol_dir_abs, file_path]) != protocol_dir_abs:
            write_error(handler, 400, '协议路径不安全')
            return

        # 生成协议文件内容
        file_content = generate_protocol_file(protocol_id, protocol_config)

        # 写入文件
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(file_content)

        write_json(handler, {
            'success': True,
            'message': f'协议 {protocol_id} 已保存到文件',
            'path': file_path
        })

    except Exception as e:
        write_error(handler, 500, f'保存失败: {str(e)}')


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
    """按协议配置白名单生成可序列化对象"""
    top_level_defaults = {
        'id': protocol_id,
        'label': raw_config.get('label') or protocol_id,
        'taskTypes': raw_config.get('taskTypes') or ['image'],
        'urlTemplate': raw_config.get('urlTemplate') or '{{endpoint}}/v1/endpoint',
        'apikeyLocation': raw_config.get('apikeyLocation') or 'header',
        'apikeyField': raw_config.get('apikeyField') or 'Authorization',
        'parameters': build_serializable_parameters(raw_config.get('parameters') or {}),
        'responsePath': raw_config.get('responsePath') or {
            'image': 'data[0].url',
            'chat': 'choices[0].message.content',
            'video': 'data.video_url'
        }
    }

    for optional_key in ('helpText', 'urlTemplates', 'fixedParams', 'videoMeta'):
        if optional_key in raw_config and raw_config.get(optional_key) not in (None, ''):
            top_level_defaults[optional_key] = raw_config.get(optional_key)

    return top_level_defaults


def build_serializable_parameters(parameters):
    """按参数字段白名单生成可序列化对象"""
    allowed_keys = {
        'id',
        'label',
        'exposed',
        'inputPort',
        'portType',
        'portCount',
        'portLabel',
        'portOnly',
        'required',
        'omitIfEmpty',
        'dataType',
        'uiControl',
        'options',
        'defaultValue',
        'requestField',
        'taskTypes',
        'min',
        'max',
        'step',
        'note',
        'description'
    }
    result = {}
    for param_id, param in parameters.items():
        if not isinstance(param, dict):
            continue
        clean_param = {}
        for key in allowed_keys:
            if key in param:
                clean_param[key] = param.get(key)
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
