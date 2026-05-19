import json
import os
import posixpath
import re
import shutil
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
from backend.services.version_service import get_app_user_agent


DOWNLOAD_CHUNK_SIZE = 64 * 1024
GITHUB_RELEASE_API_TIMEOUT = 45.0
GITHUB_DOWNLOAD_TIMEOUT = 600.0
ACTIVE_UPDATE_STATUSES = {'starting', 'resolving', 'downloading', 'extracting', 'replacing', 'canceling'}

_UPDATE_LOCK = threading.Lock()
_UPDATE_JOB = None


class UpdateCancelled(RuntimeError):
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


def _open_github_url(url, timeout):
    context = _create_ssl_context()
    handlers = [urllib_request.HTTPSHandler(context=context)]

    if state.ACTIVE_PROXY.get('enabled'):
        proxy_host = str(state.ACTIVE_PROXY.get('ip') or '127.0.0.1')
        proxy_port = str(state.ACTIVE_PROXY.get('port') or '7890')
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


def _read_github_json(url):
    try:
        with _open_github_url(url, GITHUB_RELEASE_API_TIMEOUT) as response:
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


def _download_release_zip(download_url, destination, expected_total_hint=0, progress_callback=None, cancel_event=None):
    temp_destination = destination.with_name(f'.{destination.name}.download')
    total_bytes = 0
    try:
        with _open_github_url(download_url, GITHUB_DOWNLOAD_TIMEOUT) as response:
            content_length = _parse_positive_int(response.headers.get('Content-Length'))
            expected_total = expected_total_hint or content_length
            started_at = time.monotonic()
            if progress_callback:
                progress_callback(0, expected_total, started_at)
            with open(temp_destination, 'wb') as output:
                while True:
                    if cancel_event and cancel_event.is_set():
                        raise UpdateCancelled('用户已取消下载')
                    chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
                    total_bytes += len(chunk)
                    if progress_callback:
                        progress_callback(total_bytes, expected_total, started_at)
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
    except Exception as error:
        raise RuntimeError(f'下载 Release ZIP 失败: {error}') from error
    finally:
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


def download_and_prepare_latest_update(repo=None, progress_callback=None, cancel_event=None):
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
    try:
        downloaded_bytes = _download_release_zip(
            str(asset.get('browser_download_url')),
            zip_path,
            expected_total_hint=_get_release_asset_size(asset),
            progress_callback=progress_callback,
            cancel_event=cancel_event,
        )

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
            **replacement_result,
        }
    finally:
        _delete_file_quietly(zip_path)


def _snapshot_job(job):
    if not job:
        return {'success': True, 'status': 'idle'}

    hidden_keys = {'thread', 'cancelEvent'}
    snapshot = {key: value for key, value in job.items() if key not in hidden_keys}
    snapshot['success'] = snapshot.get('status') not in {'error'}
    return snapshot


def _set_job(job, **updates):
    with _UPDATE_LOCK:
        job.update(updates)
        job['updatedAt'] = time.time()
        return _snapshot_job(job)


def _set_download_progress(job, downloaded_bytes, total_bytes, started_at):
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

        result = download_and_prepare_latest_update(
            repo,
            progress_callback=progress_callback,
            cancel_event=cancel_event,
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
    with _UPDATE_LOCK:
        if not _UPDATE_JOB or (job_id and _UPDATE_JOB.get('id') != job_id):
            return {'success': False, 'status': 'missing', 'error': '没有可取消的更新下载任务'}
        if _UPDATE_JOB.get('status') not in ACTIVE_UPDATE_STATUSES:
            return _snapshot_job(_UPDATE_JOB)
        _UPDATE_JOB['status'] = 'canceling'
        _UPDATE_JOB['message'] = '正在取消下载并清理临时文件...'
        _UPDATE_JOB['cancelEvent'].set()
        _UPDATE_JOB['updatedAt'] = time.time()
        return _snapshot_job(_UPDATE_JOB)
