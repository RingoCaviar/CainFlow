import json
import os
import posixpath
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET
from html import unescape
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import unquote

from backend import config, state
from backend.services.security_service import detect_available_proxy
from backend.services.version_service import get_app_user_agent


DOWNLOAD_CHUNK_SIZE = 64 * 1024
GITHUB_RELEASE_API_TIMEOUT = 12.0
GITHUB_DOWNLOAD_TIMEOUT = 600.0
GITHUB_DOWNLOAD_READ_TIMEOUT = 1.0
UPDATE_LOW_SPEED_BYTES_PER_SECOND = 500 * 1024
UPDATE_LOW_SPEED_SECONDS = 1.0
ACTIVE_UPDATE_STATUSES = {
    'starting',
    'resolving',
    'downloading',
    'proxy_testing',
    'proxy_switching',
    'extracting',
    'replacing',
    'canceling',
}

_UPDATE_LOCK = threading.Lock()
_UPDATE_JOB = None


class UpdateCancelled(RuntimeError):
    pass


class UpdateProxySwitch(RuntimeError):
    def __init__(self, proxy):
        super().__init__('切换到代理下载更新')
        self.proxy = proxy


class UpdateMetadataProxySwitch(RuntimeError):
    def __init__(self, proxy):
        super().__init__('切换到代理获取 Release 信息')
        self.proxy = proxy


class InvalidReleaseZip(RuntimeError):
    pass


def _delete_file_quietly(path):
    try:
        target = Path(path)
        if target.exists():
            target.unlink()
    except OSError:
        pass


def cleanup_update_temp_files():
    app_dir = Path(config.EXE_DIR).resolve()
    target_path = Path(config.MAIN_EXE_PATH).resolve()
    current_pending_path = None
    pending_script_path = None
    if target_path.parent == app_dir:
        current_pending_path = target_path.with_name(f'{target_path.stem}.update{target_path.suffix}')
        pending_script_path = target_path.with_name(_get_pending_replace_script_name())
    for pattern in (
        '.Cainflow_*.zip.download',
        'Cainflow_*.zip',
        'CainFlow*.update.exe',
        '*.update.exe',
        'CainFlow.update',
        '*.update',
    ):
        for path in app_dir.glob(pattern):
            if not path.is_file():
                continue
            is_current_pending = current_pending_path is not None and path.resolve() == current_pending_path
            if is_current_pending and pending_script_path and pending_script_path.exists():
                continue
            if is_current_pending and pending_script_path and not pending_script_path.exists():
                _delete_file_quietly(pending_script_path)
            _delete_file_quietly(path)
    if target_path.parent == app_dir:
        _delete_file_quietly(target_path.with_name(f'.{target_path.name}.new'))
        if pending_script_path and pending_script_path.exists() and not current_pending_path.exists():
            _delete_file_quietly(pending_script_path)


def _create_ssl_context():
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _normalize_update_proxy(proxy):
    if not isinstance(proxy, dict):
        return None
    host = str(proxy.get('ip') or proxy.get('host') or '').strip() or '127.0.0.1'
    port = str(proxy.get('port') or '').strip()
    if not port:
        return None
    return {
        'enabled': True,
        'ip': host,
        'port': port,
        'source': str(proxy.get('source') or proxy.get('name') or 'Local proxy').strip() or 'Local proxy',
        'latency': int(proxy.get('latency') or 0),
        'checkedTarget': str(proxy.get('checkedTarget') or '').strip(),
    }


def _get_update_proxy_info(proxy_override=None):
    forced_proxy = _normalize_update_proxy(proxy_override)
    if forced_proxy:
        return forced_proxy
    if state.ACTIVE_PROXY.get('enabled'):
        return _normalize_update_proxy({
            'ip': state.ACTIVE_PROXY.get('ip'),
            'port': state.ACTIVE_PROXY.get('port'),
            'source': 'CainFlow proxy setting',
        })
    return None


def _open_github_url(url, timeout, proxy_override=None, accept='application/vnd.github+json, application/octet-stream'):
    context = _create_ssl_context()
    handlers = [urllib_request.HTTPSHandler(context=context)]
    proxy_info = _get_update_proxy_info(proxy_override)

    if proxy_info:
        proxy_host = proxy_info['ip']
        proxy_port = proxy_info['port']
        proxy_url = f'http://{proxy_host}:{proxy_port}'
        handlers.insert(0, urllib_request.ProxyHandler({'http': proxy_url, 'https': proxy_url}))
    else:
        handlers.insert(0, urllib_request.ProxyHandler({}))

    opener = urllib_request.build_opener(*handlers)
    request = urllib_request.Request(
        url,
        headers={
            'Accept': accept,
            'User-Agent': get_app_user_agent(),
            'Connection': 'close',
        },
        method='GET',
    )
    return opener.open(request, timeout=timeout)


def _read_github_bytes(
    url,
    proxy_override=None,
    accept='*/*',
    timeout=GITHUB_RELEASE_API_TIMEOUT,
    low_speed_callback=None,
):
    total_bytes = 0
    last_speed_check_at = None
    last_speed_check_bytes = 0
    chunks = []
    try:
        with _open_github_url(url, timeout, proxy_override=proxy_override, accept=accept) as response:
            if low_speed_callback and not _get_update_proxy_info(proxy_override):
                _set_response_read_timeout(response, GITHUB_DOWNLOAD_READ_TIMEOUT)

            while True:
                try:
                    chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                except socket.timeout:
                    if low_speed_callback and not _get_update_proxy_info(proxy_override):
                        if last_speed_check_at is not None:
                            proxy = low_speed_callback(0, total_bytes, 0)
                            if proxy:
                                raise UpdateMetadataProxySwitch(proxy)
                            low_speed_callback = None
                            _set_response_read_timeout(response, timeout)
                    last_speed_check_bytes = total_bytes
                    continue

                if not chunk:
                    break
                chunks.append(chunk)
                total_bytes += len(chunk)

                now = time.monotonic()
                if last_speed_check_at is None:
                    last_speed_check_at = now
                    last_speed_check_bytes = total_bytes
                    continue

                interval = now - last_speed_check_at
                if (
                    low_speed_callback
                    and interval >= UPDATE_LOW_SPEED_SECONDS
                    and not _get_update_proxy_info(proxy_override)
                ):
                    interval_bytes = total_bytes - last_speed_check_bytes
                    interval_speed = interval_bytes / max(interval, 0.001)
                    if interval_speed < UPDATE_LOW_SPEED_BYTES_PER_SECOND:
                        proxy = low_speed_callback(interval_speed, total_bytes, 0)
                        if proxy:
                            raise UpdateMetadataProxySwitch(proxy)
                        low_speed_callback = None
                        _set_response_read_timeout(response, timeout)
                        last_speed_check_at = now
                        last_speed_check_bytes = total_bytes
                elif interval >= UPDATE_LOW_SPEED_SECONDS:
                    last_speed_check_at = now
                    last_speed_check_bytes = total_bytes

            return b''.join(chunks)
    except urllib_error.HTTPError as error:
        body = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'GitHub 返回 {error.code}: {body[:300]}') from error
    except UpdateMetadataProxySwitch:
        raise
    except Exception as error:
        raise RuntimeError(f'无法连接 GitHub: {error}') from error


def _read_github_text(url, proxy_override=None, accept='*/*', low_speed_callback=None):
    return _read_github_bytes(
        url,
        proxy_override=proxy_override,
        accept=accept,
        low_speed_callback=low_speed_callback,
    ).decode('utf-8', errors='replace')


def _read_github_json(url, proxy_override=None, low_speed_callback=None):
    raw = _read_github_bytes(
        url,
        proxy_override=proxy_override,
        accept='application/vnd.github+json',
        low_speed_callback=low_speed_callback,
    )

    try:
        return json.loads(raw.decode('utf-8'))
    except Exception as error:
        raise RuntimeError('GitHub Release 响应不是有效 JSON') from error


def _safe_zip_filename(name, tag_name):
    suffix = '_macos' if sys.platform == 'darwin' else ''
    fallback = f'Cainflow_{tag_name or "latest"}{suffix}.zip'
    filename = os.path.basename(str(name or '').strip()) or fallback
    if not filename.lower().endswith('.zip'):
        filename = fallback
    return re.sub(r'[^A-Za-z0-9._-]+', '_', filename)


def _is_release_asset_for_current_platform(name):
    normalized = str(name or '').strip().lower()
    if sys.platform == 'darwin':
        return '_macos' in normalized or '-macos' in normalized or 'macos' in normalized
    return 'macos' not in normalized and 'darwin' not in normalized


def _is_github_release_zip_url(url):
    normalized = str(url or '').strip()
    return (
        normalized.startswith('https://github.com/')
        and '/releases/download/' in normalized
        and normalized.lower().split('?', 1)[0].endswith('.zip')
    )


def _build_release_asset(asset_name, download_url, tag_name='', source=''):
    name = os.path.basename(str(asset_name or '').strip()) or os.path.basename(str(download_url or '').split('?', 1)[0])
    if not name:
        name = _safe_zip_filename('', tag_name)
    return {
        'name': name,
        'browser_download_url': str(download_url or '').strip(),
        'size': 0,
        'source': source,
    }


def _select_release_zip_asset(release_data):
    assets = release_data.get('assets') if isinstance(release_data, dict) else None
    if not isinstance(assets, list):
        assets = []

    candidates = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get('name') or '').strip()
        download_url = str(asset.get('browser_download_url') or '').strip()
        if not name.lower().endswith('.zip') or not download_url.startswith('https://github.com/'):
            continue
        if not _is_release_asset_for_current_platform(name):
            continue
        candidates.append(asset)

    if not candidates:
        raise RuntimeError('最新 Release 中没有可下载的 CainFlow ZIP 资产')

    candidates.sort(key=lambda asset: (
        0 if str(asset.get('name') or '').lower().startswith('cainflow') else 1,
        str(asset.get('name') or '').lower(),
    ))
    return candidates[0]


def _select_release_zip_asset_from_links(links, tag_name='', source=''):
    candidates = []
    for link in links:
        url = str(link or '').strip()
        if not _is_github_release_zip_url(url):
            continue
        asset_name = os.path.basename(url.split('?', 1)[0])
        if not _is_release_asset_for_current_platform(asset_name):
            continue
        candidates.append(_build_release_asset(asset_name, url, tag_name=tag_name, source=source))

    if not candidates:
        return None

    candidates.sort(key=lambda asset: (
        0 if str(asset.get('name') or '').lower().startswith('cainflow') else 1,
        str(asset.get('name') or '').lower(),
    ))
    return candidates[0]


def _parse_latest_release_from_feed(xml_text, repo_name):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    namespace = {'atom': 'http://www.w3.org/2005/Atom'}
    entries = root.findall('atom:entry', namespace) or root.findall('entry')
    for entry in entries:
        title = (entry.findtext('atom:title', default='', namespaces=namespace) or entry.findtext('title', default='')).strip()
        entry_id = (entry.findtext('atom:id', default='', namespaces=namespace) or entry.findtext('id', default='')).strip()
        href = ''
        for link in entry.findall('atom:link', namespace) or entry.findall('link'):
            href = str(link.attrib.get('href') or '').strip()
            if href:
                break
        tag_match = re.search(r'/releases/tag/([^/?#]+)', href or entry_id)
        tag_name = unquote(tag_match.group(1)) if tag_match else title
        tag_name = str(tag_name or '').strip()
        if tag_name:
            return {
                'tag_name': tag_name,
                'html_url': href or f'https://github.com/{repo_name}/releases/tag/{tag_name}',
                'source': 'github_releases_feed',
            }
    return None


def _extract_release_zip_links_from_html(html_text, repo_name):
    text = unescape(str(html_text or ''))
    escaped_repo = re.escape(repo_name)
    raw_links = []
    patterns = [
        rf'/{escaped_repo}/releases/download/[^\s"\'<>]+?\.zip(?:\?[^"\s\'<>]*)?',
        rf'https://github\.com/{escaped_repo}/releases/download/[^\s"\'<>]+?\.zip(?:\?[^"\s\'<>]*)?',
    ]
    for pattern in patterns:
        raw_links.extend(match.group(0) for match in re.finditer(pattern, text, flags=re.IGNORECASE))

    links = []
    for link in raw_links:
        normalized = unquote(str(link or ''))
        if normalized.startswith('/'):
            normalized = f'https://github.com{normalized}'
        normalized = normalized.split('?', 1)[0]
        if normalized not in links:
            links.append(normalized)
    return links


def _read_release_data_from_non_api_sources(repo_name, proxy_override=None, status_callback=None, low_speed_callback=None):
    feed_url = f'https://github.com/{repo_name}/releases.atom'
    if status_callback:
        status_callback('resolving', '正在读取 GitHub Releases Feed...')
    feed_text = _read_github_text(
        feed_url,
        proxy_override=proxy_override,
        accept='application/atom+xml, application/xml, text/xml',
        low_speed_callback=low_speed_callback,
    )
    release_data = _parse_latest_release_from_feed(feed_text, repo_name)
    if not release_data:
        raise RuntimeError('GitHub Releases Feed 响应解析失败')

    tag_name = str(release_data.get('tag_name') or '').strip()
    if not tag_name:
        raise RuntimeError('GitHub Releases Feed 未包含版本号')

    asset_links = []
    expanded_assets_url = f'https://github.com/{repo_name}/releases/expanded_assets/{tag_name}'
    try:
        if status_callback:
            status_callback('resolving', f'正在解析 {tag_name} 的更新文件列表...')
        expanded_html = _read_github_text(
            expanded_assets_url,
            proxy_override=proxy_override,
            accept='text/html,application/xhtml+xml',
            low_speed_callback=low_speed_callback,
        )
        asset_links.extend(_extract_release_zip_links_from_html(expanded_html, repo_name))
    except Exception:
        pass

    if not asset_links:
        release_page_url = f'https://github.com/{repo_name}/releases/tag/{tag_name}'
        if status_callback:
            status_callback('resolving', f'正在解析 {tag_name} 的 Release 页面...')
        release_html = _read_github_text(
            release_page_url,
            proxy_override=proxy_override,
            accept='text/html,application/xhtml+xml',
            low_speed_callback=low_speed_callback,
        )
        asset_links.extend(_extract_release_zip_links_from_html(release_html, repo_name))

    asset = _select_release_zip_asset_from_links(asset_links, tag_name=tag_name, source='github_release_page')
    if not asset:
        raise RuntimeError('GitHub Release 页面中没有找到可下载的 CainFlow ZIP 资产')

    return {
        **release_data,
        'assets': [asset],
        'source': asset.get('source') or release_data.get('source') or 'github_release_page',
    }


def _read_latest_release_data(repo_name, proxy_override=None, status_callback=None, low_speed_callback=None):
    non_api_error = None
    try:
        return _read_release_data_from_non_api_sources(
            repo_name,
            proxy_override=proxy_override,
            status_callback=status_callback,
            low_speed_callback=low_speed_callback,
        )
    except Exception as error:
        non_api_error = error

    try:
        if status_callback:
            status_callback('resolving', '非 API 更新源暂不可用，正在使用 GitHub API 备用方式...')
        return _read_latest_release_data_from_api(repo_name, proxy_override=proxy_override, low_speed_callback=low_speed_callback)
    except Exception as api_error:
        raise RuntimeError(f'获取 GitHub Release 信息失败：{non_api_error}；API 兜底也失败：{api_error}') from api_error


def _read_latest_release_data_from_api(repo_name, proxy_override=None, low_speed_callback=None):
    release_url = f'https://api.github.com/repos/{repo_name}/releases/latest'
    release_data = _read_github_json(release_url, proxy_override=proxy_override, low_speed_callback=low_speed_callback)
    release_data['source'] = release_data.get('source') or 'github_api'
    return release_data


def _get_release_asset_size(asset):
    try:
        size = int(asset.get('size') or 0)
        return size if size > 0 else 0
    except (TypeError, ValueError):
        return 0


def _parse_positive_int(value):
    try:
        number = int(value or 0)
        return number if number > 0 else 0
    except (TypeError, ValueError):
        return 0


def _validate_downloaded_zip_file(zip_path):
    try:
        with open(zip_path, 'rb') as file:
            header = file.read(4)
    except OSError as error:
        raise InvalidReleaseZip(f'下载文件读取失败：{error}') from error
    if header != b'PK\x03\x04':
        raise InvalidReleaseZip('下载到的更新文件不是有效 ZIP，正在尝试备用下载地址')


def _describe_update_proxy(proxy):
    proxy_info = _normalize_update_proxy(proxy)
    if not proxy_info:
        return ''
    source = proxy_info.get('source') or 'Local proxy'
    latency = proxy_info.get('latency') or 0
    suffix = f'，延迟 {latency}ms' if latency else ''
    return f"{source} {proxy_info['ip']}:{proxy_info['port']}{suffix}"


def _check_update_proxy_google_health(proxy):
    proxy_info = _normalize_update_proxy(proxy)
    if not proxy_info:
        return False, 0

    context = _create_ssl_context()
    proxy_url = f"http://{proxy_info['ip']}:{proxy_info['port']}"
    opener = urllib_request.build_opener(
        urllib_request.ProxyHandler({'http': proxy_url, 'https': proxy_url}),
        urllib_request.HTTPSHandler(context=context),
    )
    request = urllib_request.Request(
        'https://www.google.com/generate_204',
        headers={
            'User-Agent': 'CainFlow Update Proxy Detector',
            'Connection': 'close',
        },
        method='HEAD',
    )
    try:
        start = time.perf_counter()
        with opener.open(request, timeout=5.0):
            pass
        return True, int((time.perf_counter() - start) * 1000)
    except urllib_error.HTTPError as error:
        if error.code == 407:
            return False, 0
        return True, int((time.perf_counter() - start) * 1000)
    except Exception:
        return False, 0


def _resolve_update_download_proxy():
    configured_proxy = _normalize_update_proxy({
        'ip': state.ACTIVE_PROXY.get('ip'),
        'port': state.ACTIVE_PROXY.get('port'),
        'source': 'CainFlow proxy setting',
    })
    if configured_proxy:
        success, result = _check_update_proxy_google_health(configured_proxy)
        if success:
            configured_proxy['latency'] = int(result or 0)
            configured_proxy['checkedTarget'] = 'Google 204'
            return configured_proxy

    detected = detect_available_proxy()
    detected_proxy = _normalize_update_proxy(detected.get('proxy') if isinstance(detected, dict) else None)
    if not detected_proxy:
        return None

    success, result = _check_update_proxy_google_health(detected_proxy)
    if not success:
        return None
    detected_proxy['latency'] = int(result or 0)
    detected_proxy['checkedTarget'] = 'Google 204'
    return detected_proxy


def _set_response_read_timeout(response, timeout):
    try:
        if hasattr(response, 'fp') and getattr(response.fp, 'raw', None):
            sock = getattr(response.fp.raw, '_sock', None)
            if sock:
                sock.settimeout(timeout)
    except Exception:
        pass


def _download_release_zip(
    download_url,
    destination,
    expected_total_hint=0,
    progress_callback=None,
    cancel_event=None,
    response_callback=None,
    low_speed_callback=None,
    proxy_override=None,
):
    temp_destination = destination.with_name(f'.{destination.name}.download')
    total_bytes = 0
    last_speed_check_at = None
    last_speed_check_bytes = 0
    try:
        with _open_github_url(download_url, GITHUB_DOWNLOAD_TIMEOUT, proxy_override=proxy_override) as response:
            _set_response_read_timeout(response, GITHUB_DOWNLOAD_READ_TIMEOUT)
            if response_callback:
                response_callback(response)
            content_length = _parse_positive_int(response.headers.get('Content-Length'))
            expected_total = expected_total_hint or content_length
            started_at = time.monotonic()
            if progress_callback:
                progress_callback(0, expected_total, started_at)
            with open(temp_destination, 'wb') as output:
                while True:
                    if cancel_event and cancel_event.is_set():
                        raise UpdateCancelled('用户已取消下载')
                    try:
                        chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                    except socket.timeout:
                        if (
                            low_speed_callback
                            and not _get_update_proxy_info(proxy_override)
                            and last_speed_check_at is not None
                        ):
                            proxy = low_speed_callback(0, total_bytes, expected_total)
                            if proxy:
                                raise UpdateProxySwitch(proxy)
                            low_speed_callback = None
                            _set_response_read_timeout(response, GITHUB_DOWNLOAD_TIMEOUT)
                        last_speed_check_bytes = total_bytes
                        continue
                    if not chunk:
                        break
                    output.write(chunk)
                    total_bytes += len(chunk)
                    if progress_callback:
                        progress_callback(total_bytes, expected_total, started_at)
                    now = time.monotonic()
                    if last_speed_check_at is None:
                        last_speed_check_at = now
                        last_speed_check_bytes = total_bytes
                        if cancel_event and cancel_event.is_set():
                            raise UpdateCancelled('用户已取消下载')
                        continue

                    interval = now - last_speed_check_at
                    if (
                        low_speed_callback
                        and interval >= UPDATE_LOW_SPEED_SECONDS
                        and not _get_update_proxy_info(proxy_override)
                    ):
                        interval_bytes = total_bytes - last_speed_check_bytes
                        interval_speed = interval_bytes / max(interval, 0.001)
                        if interval_speed < UPDATE_LOW_SPEED_BYTES_PER_SECOND:
                            proxy = low_speed_callback(interval_speed, total_bytes, expected_total)
                            if proxy:
                                raise UpdateProxySwitch(proxy)
                            low_speed_callback = None
                            _set_response_read_timeout(response, GITHUB_DOWNLOAD_TIMEOUT)
                            last_speed_check_at = now
                            last_speed_check_bytes = total_bytes
                    elif interval >= UPDATE_LOW_SPEED_SECONDS:
                        last_speed_check_at = now
                        last_speed_check_bytes = total_bytes
                    if cancel_event and cancel_event.is_set():
                        raise UpdateCancelled('用户已取消下载')
        if progress_callback:
            progress_callback(total_bytes, total_bytes, started_at)
        os.replace(temp_destination, destination)
        _validate_downloaded_zip_file(destination)
        return total_bytes
    except urllib_error.HTTPError as error:
        body = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'下载 Release ZIP 失败，GitHub 返回 {error.code}: {body[:300]}') from error
    except UpdateCancelled:
        raise
    except UpdateProxySwitch:
        raise
    except InvalidReleaseZip:
        raise
    except Exception as error:
        if cancel_event and cancel_event.is_set():
            raise UpdateCancelled('用户已取消下载') from error
        raise RuntimeError(f'下载 Release ZIP 失败: {error}') from error
    finally:
        if response_callback:
            response_callback(None)
        _delete_file_quietly(temp_destination)


def _find_main_program_member(zip_path):
    preferred_name = config.UPDATE_MAIN_EXE_NAME.lower()
    fallback_candidates = []

    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            basename = posixpath.basename(member.filename).lower()
            if basename == preferred_name:
                return member.filename
            if sys.platform == 'darwin' and basename == 'cainflow':
                fallback_candidates.append(member.filename)
            if sys.platform != 'darwin' and basename.endswith('.exe') and 'cainflow' in basename:
                fallback_candidates.append(member.filename)

    if fallback_candidates:
        return sorted(fallback_candidates, key=lambda value: value.lower())[0]

    raise RuntimeError(f'ZIP 包内没有找到 {config.UPDATE_MAIN_EXE_NAME}，已停止更新以避免误覆盖')


def _has_valid_program_header(path):
    with open(path, 'rb') as file:
        header = file.read(4)
    if sys.platform == 'darwin':
        return (
            header in {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe'}
            or header.startswith(b'#!')
        )
    return header.startswith(b'MZ')


def _extract_main_program_to_temp(zip_path, member_name, target_path):
    temp_program = target_path.with_name(f'.{target_path.name}.new')
    _delete_file_quietly(temp_program)

    try:
        with zipfile.ZipFile(zip_path) as archive:
            with archive.open(member_name) as source:
                with open(temp_program, 'wb') as output:
                    shutil.copyfileobj(source, output)
    except Exception:
        _delete_file_quietly(temp_program)
        raise

    if temp_program.stat().st_size <= 0:
        _delete_file_quietly(temp_program)
        raise RuntimeError('ZIP 中的 CainFlow 主程序为空，已停止更新')

    if not _has_valid_program_header(temp_program):
        _delete_file_quietly(temp_program)
        platform_name = 'macOS' if sys.platform == 'darwin' else 'Windows'
        raise RuntimeError(f'ZIP 中的 CainFlow 主程序不是有效的 {platform_name} 可执行文件，已停止更新')

    if sys.platform == 'darwin':
        temp_program.chmod(temp_program.stat().st_mode | 0o755)

    return temp_program


def _escape_batch_path(path):
    return str(path).replace('%', '%%')


def _escape_shell_single_quoted_path(path):
    return str(path).replace("'", "'\"'\"'")


def _get_pending_replace_script_name():
    return 'apply_cainflow_update.command' if sys.platform == 'darwin' else 'apply_cainflow_update.bat'


def _write_pending_replace_script(pending_path, target_path):
    script_path = target_path.with_name(_get_pending_replace_script_name())
    pid = os.getpid()
    if sys.platform == 'darwin':
        source = _escape_shell_single_quoted_path(pending_path)
        target = _escape_shell_single_quoted_path(target_path)
        script = f'''#!/bin/sh
SOURCE='{source}'
TARGET='{target}'
PID='{pid}'

while kill -0 "$PID" >/dev/null 2>&1; do
    sleep 1
done

while ! mv -f "$SOURCE" "$TARGET"; do
    sleep 1
done
chmod +x "$TARGET" >/dev/null 2>&1
rm -- "$0" >/dev/null 2>&1
'''
        script_path.write_text(script, encoding='utf-8')
        script_path.chmod(0o755)
        return script_path

    script = f'''@echo off
chcp 65001 >nul
set "SOURCE={_escape_batch_path(pending_path)}"
set "TARGET={_escape_batch_path(target_path)}"
set "PID={pid}"

:wait_process
tasklist /FI "PID eq %PID%" | find "%PID%" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_process
)

:replace_program
move /Y "%SOURCE%" "%TARGET%" >nul
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto replace_program
)
del "%~f0" >nul 2>nul
'''
    script_path.write_text(script, encoding='utf-8')
    return script_path


def _launch_pending_replace_script(script_path):
    if sys.platform == 'darwin':
        subprocess.Popen(
            ['/bin/sh', str(script_path)],
            cwd=str(script_path.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True

    if os.name != 'nt':
        return False

    creation_flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    subprocess.Popen(
        ['cmd.exe', '/c', str(script_path)],
        cwd=str(script_path.parent),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
    )
    return True


def _replace_main_program(temp_program, target_path):
    try:
        os.replace(temp_program, target_path)
        if sys.platform == 'darwin':
            target_path.chmod(target_path.stat().st_mode | 0o755)
        return {
            'applied': True,
            'replacementPending': False,
            'message': '更新已下载并覆盖 CainFlow 主程序，请重启 CainFlow 主程序。',
        }
    except OSError as replace_error:
        if os.name != 'nt' and sys.platform != 'darwin':
            raise
        try:
            pending_path = target_path.with_name(f'{target_path.stem}.update{target_path.suffix}')
            _delete_file_quietly(pending_path)
            os.replace(temp_program, pending_path)
            if sys.platform == 'darwin':
                pending_path.chmod(pending_path.stat().st_mode | 0o755)
            script_path = _write_pending_replace_script(pending_path, target_path)
            helper_started = _launch_pending_replace_script(script_path)
            platform_note = '关闭当前程序后会自动覆盖；请随后重新启动 CainFlow 主程序。'
            return {
                'applied': False,
                'replacementPending': True,
                'pendingPath': str(pending_path),
                'helperPath': str(script_path),
                'helperStarted': helper_started,
                'replaceError': str(replace_error),
                'message': f'更新已下载完成。当前 CainFlow 主程序正在运行，{platform_note}',
            }
        except Exception as pending_error:
            raise RuntimeError(
                f'更新文件已下载，但覆盖 CainFlow 主程序失败：{replace_error}；'
                f'尝试创建关闭后自动覆盖任务也失败：{pending_error}'
            ) from pending_error


def download_and_prepare_latest_update(
    repo=None,
    progress_callback=None,
    cancel_event=None,
    response_callback=None,
    status_callback=None,
):
    repo_name = str(repo or config.GITHUB_REPO).strip()
    if repo_name != config.GITHUB_REPO:
        raise RuntimeError('不允许从当前 CainFlow 官方仓库以外的位置下载更新')

    proxy_override = None
    metadata_proxy_switched = False

    def metadata_low_speed_callback(interval_speed, downloaded_bytes, total_bytes):
        nonlocal metadata_proxy_switched
        if metadata_proxy_switched:
            return None
        metadata_proxy_switched = True
        if status_callback:
            status_callback(
                'proxy_testing',
                '获取 Release 信息速度过慢，正在测试代理连通性...',
                downloaded_bytes,
                total_bytes,
            )
        proxy = _resolve_update_download_proxy()
        if not proxy:
            if status_callback:
                status_callback(
                    'resolving',
                    '未找到可用代理，继续使用当前连接获取 Release 信息...',
                    downloaded_bytes,
                    total_bytes,
                )
            return None
        if status_callback:
            status_callback(
                'proxy_switching',
                f'已找到可用代理（{_describe_update_proxy(proxy)}），正在切换代理获取 Release 信息...',
                downloaded_bytes,
                total_bytes,
            )
        return proxy

    def resolve_release_download_info(active_proxy=None):
        current_release_data = _read_latest_release_data(
            repo_name,
            proxy_override=active_proxy,
            status_callback=status_callback,
            low_speed_callback=metadata_low_speed_callback,
        )
        current_asset = _select_release_zip_asset(current_release_data)
        current_tag_name = str(current_release_data.get('tag_name') or '').strip()
        current_zip_filename = _safe_zip_filename(current_asset.get('name'), current_tag_name)
        return current_release_data, current_asset, current_tag_name, current_zip_filename

    try:
        release_data, asset, tag_name, zip_filename = resolve_release_download_info()
    except UpdateMetadataProxySwitch as switch:
        proxy_override = switch.proxy
        release_data, asset, tag_name, zip_filename = resolve_release_download_info(proxy_override)
    except Exception as release_error:
        if status_callback:
            status_callback('proxy_testing', '获取 Release 信息超时或失败，正在尝试使用代理解析更新信息...')
        proxy_override = _resolve_update_download_proxy()
        if not proxy_override:
            raise release_error
        if status_callback:
            status_callback('proxy_switching', f'已找到可用代理（{_describe_update_proxy(proxy_override)}），正在重新获取 Release 信息...')
        release_data, asset, tag_name, zip_filename = resolve_release_download_info(proxy_override)

    api_asset_fallback_used = release_data.get('source') == 'github_api'
    if cancel_event and cancel_event.is_set():
        raise UpdateCancelled('用户已取消下载')

    app_dir = Path(config.EXE_DIR).resolve()
    app_dir.mkdir(parents=True, exist_ok=True)
    zip_path = app_dir / zip_filename
    proxy_switched = bool(proxy_override)

    def low_speed_callback(interval_speed, downloaded_bytes, total_bytes):
        nonlocal proxy_switched
        if proxy_switched:
            return None
        proxy_switched = True
        if status_callback:
            status_callback(
                'proxy_testing',
                f'下载速度持续低于 500KB/s，正在测试代理连通性...',
                downloaded_bytes,
                total_bytes,
            )
        proxy = _resolve_update_download_proxy()
        if not proxy:
            if status_callback:
                status_callback(
                    'downloading',
                    '未找到可用代理，继续使用当前连接下载更新...',
                    downloaded_bytes,
                    total_bytes,
                )
            return None
        if status_callback:
            status_callback(
                'proxy_switching',
                f'已找到可用代理（{_describe_update_proxy(proxy)}），正在切换到代理重新下载更新...',
                downloaded_bytes,
                total_bytes,
            )
        return proxy

    try:
        while True:
            try:
                downloaded_bytes = _download_release_zip(
                    str(asset.get('browser_download_url')),
                    zip_path,
                    expected_total_hint=_get_release_asset_size(asset),
                    progress_callback=progress_callback,
                    cancel_event=cancel_event,
                    response_callback=response_callback,
                    low_speed_callback=low_speed_callback,
                    proxy_override=proxy_override,
                )
                break
            except UpdateProxySwitch as switch:
                proxy_override = switch.proxy
                _delete_file_quietly(zip_path)
                if cancel_event and cancel_event.is_set():
                    raise UpdateCancelled('用户已取消下载')
                release_data, asset, tag_name, zip_filename = resolve_release_download_info(proxy_override)
                api_asset_fallback_used = release_data.get('source') == 'github_api'
                zip_path = app_dir / zip_filename
            except InvalidReleaseZip:
                _delete_file_quietly(zip_path)
                if api_asset_fallback_used:
                    raise
                if status_callback:
                    status_callback(
                        'resolving',
                        '页面解析到的更新文件不是有效 ZIP，正在使用 GitHub API 备用地址...',
                    )
                release_data = _read_latest_release_data_from_api(repo_name, proxy_override=proxy_override)
                asset = _select_release_zip_asset(release_data)
                tag_name = str(release_data.get('tag_name') or '').strip()
                zip_filename = _safe_zip_filename(asset.get('name'), tag_name)
                api_asset_fallback_used = True
                zip_path = app_dir / zip_filename

        if cancel_event and cancel_event.is_set():
            raise UpdateCancelled('用户已取消下载')

        target_path = Path(config.MAIN_EXE_PATH).resolve()
        if target_path.parent != app_dir:
            raise RuntimeError('更新目标路径异常，已停止更新')

        member_name = _find_main_program_member(zip_path)
        temp_exe = _extract_main_program_to_temp(zip_path, member_name, target_path)

        if cancel_event and cancel_event.is_set():
            _delete_file_quietly(temp_exe)
            raise UpdateCancelled('用户已取消下载')

        replacement_result = _replace_main_program(temp_exe, target_path)

        return {
            'success': True,
            'tagName': tag_name,
            'assetName': str(asset.get('name') or zip_filename),
            'targetPath': str(target_path),
            'extractedMember': member_name,
            'downloadedBytes': downloaded_bytes,
            'totalBytes': downloaded_bytes,
            'proxy': _normalize_update_proxy(proxy_override),
            **replacement_result,
        }
    finally:
        _delete_file_quietly(zip_path)


def _snapshot_job(job):
    if not job:
        return {'success': True, 'status': 'idle'}

    hidden_keys = {'thread', 'cancelEvent', 'downloadResponse'}
    snapshot = {key: value for key, value in job.items() if key not in hidden_keys}
    snapshot['success'] = snapshot.get('status') not in {'error'}
    return snapshot


def _set_job(job, **updates):
    with _UPDATE_LOCK:
        job.update(updates)
        job['updatedAt'] = time.time()
        return _snapshot_job(job)


def _set_download_progress(job, downloaded_bytes, total_bytes, started_at):
    if job.get('cancelEvent') and job['cancelEvent'].is_set():
        return
    elapsed = max(time.monotonic() - started_at, 0.001)
    speed = int(downloaded_bytes / elapsed)
    safe_total = max(int(total_bytes or 0), int(downloaded_bytes or 0))
    percent = round((downloaded_bytes / safe_total) * 100, 1) if safe_total else None
    _set_job(
        job,
        status='downloading',
        downloadedBytes=downloaded_bytes,
        totalBytes=safe_total,
        speedBytesPerSecond=speed,
        percent=percent,
    )


def _run_update_job(job, repo):
    cancel_event = job['cancelEvent']
    try:
        _set_job(job, status='resolving', message='正在获取 GitHub 最新 Release 信息...')

        def progress_callback(downloaded_bytes, total_bytes, started_at):
            _set_download_progress(job, downloaded_bytes, total_bytes, started_at)

        def response_callback(response):
            with _UPDATE_LOCK:
                if job is _UPDATE_JOB:
                    job['downloadResponse'] = response

        def status_callback(status, message, downloaded_bytes=None, total_bytes=None):
            updates = {
                'status': status,
                'message': message,
                'speedBytesPerSecond': 0,
            }
            if downloaded_bytes is not None:
                updates['downloadedBytes'] = downloaded_bytes
            if total_bytes is not None:
                updates['totalBytes'] = total_bytes
            _set_job(job, **updates)

        result = download_and_prepare_latest_update(
            repo,
            progress_callback=progress_callback,
            cancel_event=cancel_event,
            response_callback=response_callback,
            status_callback=status_callback,
        )
        _set_job(
            job,
            status='completed',
            message=result.get('message') or '更新已完成，请重启 CainFlow 主程序。',
            result=result,
            downloadedBytes=result.get('downloadedBytes') or job.get('downloadedBytes') or 0,
            totalBytes=result.get('totalBytes') or result.get('downloadedBytes') or job.get('totalBytes') or 0,
            speedBytesPerSecond=0,
            percent=100,
        )
    except UpdateCancelled as error:
        _set_job(
            job,
            status='canceled',
            message=str(error) or '下载已取消，未完成的临时文件已删除。',
            speedBytesPerSecond=0,
        )
    except Exception as error:
        _set_job(
            job,
            status='error',
            error=str(error),
            message=f'下载更新失败：{error}',
            speedBytesPerSecond=0,
        )


def start_update_download(repo=None):
    repo_name = str(repo or config.GITHUB_REPO).strip()
    if repo_name != config.GITHUB_REPO:
        raise RuntimeError('不允许从当前 CainFlow 官方仓库以外的位置下载更新')

    global _UPDATE_JOB
    with _UPDATE_LOCK:
        if _UPDATE_JOB and _UPDATE_JOB.get('status') in ACTIVE_UPDATE_STATUSES:
            snapshot = _snapshot_job(_UPDATE_JOB)
            snapshot['alreadyRunning'] = True
            return snapshot

        cleanup_update_temp_files()

        job = {
            'id': uuid.uuid4().hex,
            'status': 'starting',
            'message': '正在准备下载更新...',
            'downloadedBytes': 0,
            'totalBytes': 0,
            'speedBytesPerSecond': 0,
            'percent': None,
            'startedAt': time.time(),
            'updatedAt': time.time(),
            'cancelEvent': threading.Event(),
            'downloadResponse': None,
            'thread': None,
        }
        thread = threading.Thread(target=_run_update_job, args=(job, repo_name), daemon=True)
        job['thread'] = thread
        _UPDATE_JOB = job
        snapshot = _snapshot_job(job)

    thread.start()
    return snapshot


def get_update_download_status(job_id=None):
    with _UPDATE_LOCK:
        if job_id and _UPDATE_JOB and _UPDATE_JOB.get('id') != job_id:
            return {'success': False, 'status': 'missing', 'error': '更新任务不存在或已过期'}
        return _snapshot_job(_UPDATE_JOB)


def cancel_update_download(job_id=None):
    download_response = None
    with _UPDATE_LOCK:
        if not _UPDATE_JOB or (job_id and _UPDATE_JOB.get('id') != job_id):
            return {'success': False, 'status': 'missing', 'error': '没有可取消的更新下载任务'}
        if _UPDATE_JOB.get('status') not in ACTIVE_UPDATE_STATUSES:
            return _snapshot_job(_UPDATE_JOB)
        _UPDATE_JOB['status'] = 'canceling'
        _UPDATE_JOB['message'] = '正在取消下载并清理临时文件...'
        _UPDATE_JOB['cancelEvent'].set()
        _UPDATE_JOB['updatedAt'] = time.time()
        download_response = _UPDATE_JOB.get('downloadResponse')
        snapshot = _snapshot_job(_UPDATE_JOB)

    if download_response:
        try:
            download_response.close()
        except Exception:
            pass

    return snapshot
