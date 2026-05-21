import json
import os
import posixpath
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

from backend import config, state
from backend.services.security_service import detect_available_proxy
from backend.services.version_service import get_app_user_agent


DOWNLOAD_CHUNK_SIZE = 64 * 1024
GITHUB_RELEASE_API_TIMEOUT = 45.0
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
    for pattern in (
        '.Cainflow_*.zip.download',
        'Cainflow_*.zip',
    ):
        for path in app_dir.glob(pattern):
            if path.is_file():
                _delete_file_quietly(path)
    if target_path.parent == app_dir:
        _delete_file_quietly(target_path.with_name(f'.{target_path.name}.new'))


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


def _open_github_url(url, timeout, proxy_override=None):
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
            'Accept': 'application/vnd.github+json, application/octet-stream',
            'User-Agent': get_app_user_agent(),
            'Connection': 'close',
        },
        method='GET',
    )
    return opener.open(request, timeout=timeout)


def _read_github_json(url, proxy_override=None):
    try:
        with _open_github_url(url, GITHUB_RELEASE_API_TIMEOUT, proxy_override=proxy_override) as response:
            raw = response.read()
    except urllib_error.HTTPError as error:
        body = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'GitHub 返回 {error.code}: {body[:300]}') from error
    except Exception as error:
        raise RuntimeError(f'无法连接 GitHub: {error}') from error

    try:
        return json.loads(raw.decode('utf-8'))
    except Exception as error:
        raise RuntimeError('GitHub Release 响应不是有效 JSON') from error


def _safe_zip_filename(name, tag_name):
    fallback = f'Cainflow_{tag_name or "latest"}.zip'
    filename = os.path.basename(str(name or '').strip()) or fallback
    if not filename.lower().endswith('.zip'):
        filename = fallback
    return re.sub(r'[^A-Za-z0-9._-]+', '_', filename)


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
        candidates.append(asset)

    if not candidates:
        raise RuntimeError('最新 Release 中没有可下载的 CainFlow ZIP 资产')

    candidates.sort(key=lambda asset: (
        0 if str(asset.get('name') or '').lower().startswith('cainflow') else 1,
        str(asset.get('name') or '').lower(),
    ))
    return candidates[0]


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
    last_speed_check_at = time.monotonic()
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
                        ):
                            proxy = low_speed_callback(0, total_bytes, expected_total)
                            if proxy:
                                raise UpdateProxySwitch(proxy)
                            low_speed_callback = None
                            _set_response_read_timeout(response, GITHUB_DOWNLOAD_TIMEOUT)
                        last_speed_check_at = time.monotonic()
                        last_speed_check_bytes = total_bytes
                        continue
                    if not chunk:
                        break
                    output.write(chunk)
                    total_bytes += len(chunk)
                    if progress_callback:
                        progress_callback(total_bytes, expected_total, started_at)
                    now = time.monotonic()
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
        return total_bytes
    except urllib_error.HTTPError as error:
        body = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'下载 Release ZIP 失败，GitHub 返回 {error.code}: {body[:300]}') from error
    except UpdateCancelled:
        raise
    except UpdateProxySwitch:
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
            if basename.endswith('.exe') and 'cainflow' in basename:
                fallback_candidates.append(member.filename)

    if fallback_candidates:
        return sorted(fallback_candidates, key=lambda value: value.lower())[0]

    raise RuntimeError(f'ZIP 包内没有找到 {config.UPDATE_MAIN_EXE_NAME}，已停止更新以避免误覆盖')


def _extract_main_program_to_temp(zip_path, member_name, target_path):
    temp_exe = target_path.with_name(f'.{target_path.name}.new')
    _delete_file_quietly(temp_exe)

    try:
        with zipfile.ZipFile(zip_path) as archive:
            with archive.open(member_name) as source:
                with open(temp_exe, 'wb') as output:
                    shutil.copyfileobj(source, output)
    except Exception:
        _delete_file_quietly(temp_exe)
        raise

    if temp_exe.stat().st_size <= 0:
        _delete_file_quietly(temp_exe)
        raise RuntimeError('ZIP 中的 CainFlow 主程序为空，已停止更新')

    with open(temp_exe, 'rb') as file:
        if file.read(2) != b'MZ':
            _delete_file_quietly(temp_exe)
            raise RuntimeError('ZIP 中的 CainFlow 主程序不是有效的 Windows 可执行文件，已停止更新')

    return temp_exe


def _escape_batch_path(path):
    return str(path).replace('%', '%%')


def _write_pending_replace_script(pending_path, target_path):
    script_path = target_path.with_name('apply_cainflow_update.bat')
    pid = os.getpid()
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


def _replace_main_program(temp_exe, target_path):
    try:
        os.replace(temp_exe, target_path)
        return {
            'applied': True,
            'replacementPending': False,
            'message': '更新已下载并覆盖 CainFlow 主程序，请重启 CainFlow 主程序。',
        }
    except OSError as replace_error:
        if os.name != 'nt':
            raise
        try:
            pending_path = target_path.with_name(f'{target_path.stem}.update{target_path.suffix}')
            _delete_file_quietly(pending_path)
            os.replace(temp_exe, pending_path)
            script_path = _write_pending_replace_script(pending_path, target_path)
            helper_started = _launch_pending_replace_script(script_path)
            return {
                'applied': False,
                'replacementPending': True,
                'pendingPath': str(pending_path),
                'helperPath': str(script_path),
                'helperStarted': helper_started,
                'replaceError': str(replace_error),
                'message': '更新已下载完成。当前 CainFlow 主程序正在运行，关闭当前程序后会自动覆盖；请随后重新启动 CainFlow 主程序。',
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

    release_url = f'https://api.github.com/repos/{repo_name}/releases/latest'
    release_data = _read_github_json(release_url)
    asset = _select_release_zip_asset(release_data)
    if cancel_event and cancel_event.is_set():
        raise UpdateCancelled('用户已取消下载')

    app_dir = Path(config.EXE_DIR).resolve()
    app_dir.mkdir(parents=True, exist_ok=True)
    tag_name = str(release_data.get('tag_name') or '').strip()
    zip_filename = _safe_zip_filename(asset.get('name'), tag_name)
    zip_path = app_dir / zip_filename
    proxy_override = None
    proxy_switched = False

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
