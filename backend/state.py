from urllib.parse import urlparse


ACTIVE_PROXY = {
    'enabled': False,
    'ip': '127.0.0.1',
    'port': '7890'
}

CUSTOM_ALLOWED_HOSTS = []

NOISE_PATHS = {
    '/favicon.ico',
    '/main.js',
    '/app.js',
    '/utils.js',
    '/api.js',
    '/workflow.js',
    '/nodes.js'
}

NOISE_SUBSTRINGS = [
    'layui',
    'laydate',
    'layer.css',
    'code.css',
    'theme/default'
]


def is_noise_request(raw_path):
    parsed_path = urlparse(raw_path).path or ''
    if parsed_path in NOISE_PATHS:
        return True
    return any(pattern in parsed_path for pattern in NOISE_SUBSTRINGS)
"""维护后端运行期共享状态，如代理配置和静态资源过滤规则。"""
