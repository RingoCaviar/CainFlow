import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.services import update_service
from backend.services.desktop_bridge import DesktopBridge


class UpdateRestartTests(unittest.TestCase):
    def test_completed_update_arms_once_and_retry_reuses_the_waiting_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / 'CainFlow.exe'
            target.write_bytes(b'controlled new program')
            result = {'success': True, 'applied': True, 'targetPath': str(target)}
            with mock.patch.object(update_service, '_UPDATE_JOB', None), \
                 mock.patch.object(update_service.config, 'MAIN_EXE_PATH', str(target)), \
                 mock.patch.object(update_service.config, 'EXE_DIR', directory), \
                 mock.patch.object(update_service.sys, 'executable', str(target)), \
                 mock.patch.object(update_service.sys, 'frozen', True, create=True), \
                 mock.patch.object(update_service, 'download_and_prepare_latest_update', return_value=result), \
                 mock.patch.object(update_service, '_launch_pending_replace_script', return_value=True) as launch:
                job = update_service.start_update_download()
                deadline = time.monotonic() + 3
                while update_service.get_update_download_status(job['id'])['status'] != 'completed':
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
                with self.assertRaises(RuntimeError):
                    update_service.request_update_restart('stale-job')
                self.assertTrue(update_service.request_update_restart(job['id']))
                self.assertTrue(update_service.request_update_restart(job['id']))
                marker = update_service._get_restart_marker_path(target)
                self.assertEqual(marker.read_text(), job['id'])
                update_service.cancel_update_restart(job['id'])
                self.assertFalse(marker.exists())
                self.assertTrue(update_service.request_update_restart(job['id']))
                launch.assert_called_once()
                with self.assertRaises(RuntimeError):
                    update_service.start_update_download()

    def test_rejects_restart_without_a_completed_update(self):
        with mock.patch.object(update_service, '_UPDATE_JOB', None):
            with self.assertRaises(RuntimeError):
                update_service.request_update_restart('missing')

    def test_bridge_does_not_close_when_restart_preparation_fails(self):
        bridge = DesktopBridge('test', mock.Mock())
        bridge._window = mock.Mock()
        with mock.patch.object(update_service, 'request_update_restart', side_effect=RuntimeError('not ready')):
            with self.assertRaises(RuntimeError):
                bridge.restart_after_update('job')
        bridge._window.destroy.assert_not_called()

    def test_bridge_disarms_restart_when_window_cannot_close(self):
        bridge = DesktopBridge('test', mock.Mock())
        bridge._window = mock.Mock()
        bridge._window.destroy.side_effect = RuntimeError('cannot close')
        with mock.patch.object(update_service, 'request_update_restart'), mock.patch.object(update_service, 'cancel_update_restart') as cancel:
            with self.assertRaises(RuntimeError):
                bridge.restart_after_update('job')
            cancel.assert_called_once_with('job')
        self.assertFalse(bridge._close_allowed)

    @unittest.skipUnless(os.name == 'nt', 'Windows helper integration')
    def test_helper_waits_for_exit_then_replaces_and_relaunches_only_when_armed(self):
        for replace, armed in ((False, True), (True, False), (True, True)):
            with self.subTest(replace=replace, armed=armed), tempfile.TemporaryDirectory(prefix='cainflow restart ') as directory:
                root = Path(directory)
                target = root / 'app.cmd'
                pending = root / 'app.update.cmd'
                launched = root / 'launched.txt'
                target.write_text('@echo old\n', encoding='utf-8')
                program = f'@echo off\necho new>"{launched}"\n'
                (pending if replace else target).write_text(program, encoding='utf-8')
                sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], creationflags=subprocess.CREATE_NO_WINDOW)
                helpers = []
                popen = subprocess.Popen
                def launch(*args, **kwargs):
                    process = popen(*args, **kwargs)
                    helpers.append(process)
                    return process
                try:
                    with mock.patch.object(update_service.os, 'getpid', return_value=sleeper.pid):
                        helper = update_service._write_pending_replace_script(pending if replace else None, target)
                        marker = update_service._get_restart_marker_path(target)
                    if armed:
                        marker.write_text('restart', encoding='utf-8')
                    with mock.patch.object(update_service.subprocess, 'Popen', side_effect=launch):
                        update_service._launch_pending_replace_script(helper)
                    time.sleep(0.25)
                    self.assertEqual(pending.exists(), replace)
                    self.assertFalse(launched.exists())
                    sleeper.terminate()
                    sleeper.wait(timeout=5)
                    deadline = time.monotonic() + 10
                    while helper.exists() and time.monotonic() < deadline:
                        time.sleep(0.1)
                    self.assertFalse(helper.exists(), 'helper must finish')
                    self.assertFalse(pending.exists())
                    self.assertIn('echo new', target.read_text())
                    if armed:
                        while not launched.exists() and time.monotonic() < deadline:
                            time.sleep(0.1)
                    self.assertEqual(launched.exists(), armed)
                finally:
                    if sleeper.poll() is None:
                        sleeper.terminate()
                        sleeper.wait(timeout=5)
                    for process in helpers:
                        process.wait(timeout=12)


if __name__ == '__main__':
    unittest.main()
