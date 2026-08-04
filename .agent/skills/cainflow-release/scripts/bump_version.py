#!/usr/bin/env python3
import argparse
import pathlib
import re
import sys


VERSION_PATTERN = re.compile(
    r"(export\s+const\s+APP_VERSION_NUMBER\s*=\s*['\"])(\d+\.\d+\.\d+)(['\"]\s*;)"
)


def parse_version(value):
    parts = value.split('.')
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError(f'版本号必须是三个十进制整数段：{value}')
    major, minor, patch = (int(part) for part in parts)
    if minor > 9 or patch > 9:
        raise ValueError(f'次版本和补丁版本必须在 0..9 范围内：{value}')
    return major, minor, patch


def next_version(value):
    major, minor, patch = parse_version(value)
    patch += 1
    if patch == 10:
        patch = 0
        minor += 1
    if minor == 10:
        minor = 0
        major += 1
    return f'{major}.{minor}.{patch}'


def default_constants_path():
    return pathlib.Path(__file__).resolve().parents[4] / 'js' / 'core' / 'constants.js'


def read_current_version(constants_path):
    content = constants_path.read_text(encoding='utf-8')
    match = VERSION_PATTERN.search(content)
    if not match:
        raise ValueError(f'未在 {constants_path} 找到 APP_VERSION_NUMBER')
    return content, match.group(2)


def main():
    parser = argparse.ArgumentParser(description='计算并更新 CainFlow 十进制逐级进位版本号')
    parser.add_argument('--constants', type=pathlib.Path, default=default_constants_path())
    parser.add_argument('--current', help='仅计算指定版本，不能与 --write 同用')
    parser.add_argument('--write', action='store_true', help='将下一版本写回 APP_VERSION_NUMBER')
    args = parser.parse_args()

    if args.current and args.write:
        parser.error('--current 不能与 --write 同用')

    try:
        if args.current:
            current = args.current
            content = None
        else:
            args.constants = args.constants.resolve()
            content, current = read_current_version(args.constants)
        target = next_version(current)
        if args.write:
            updated, count = VERSION_PATTERN.subn(rf'\g<1>{target}\g<3>', content, count=1)
            if count != 1:
                raise ValueError('版本号写入失败：匹配数量不是 1')
            args.constants.write_text(updated, encoding='utf-8', newline='')
        print(target)
        return 0
    except (OSError, ValueError) as error:
        print(f'错误：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
