"""Actual Windows read-handle / atomic JSON replacement races.

Every handle and subprocess uses a fresh owned fixture path. These tests do not
read or change the production daemon, spool, profiles, Docker or model files.
The writer invokes the production protocol.atomic_json function, and observed
sharing failures originate from CreateFileW / os.replace rather than a mock.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
WRITER = r"""
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import protocol
target, blocked = Path(sys.argv[2]), Path(sys.argv[3])
replace = os.replace
attempts = 0
failures = []
def observed_replace(source, destination):
    global attempts
    attempts += 1
    try:
        return replace(source, destination)
    except OSError as error:
        failures.append(getattr(error, 'winerror', None))
        blocked.write_text('actual Windows replacement denied', encoding='ascii')
        raise
protocol.os.replace = observed_replace
started = time.monotonic()
try:
    protocol.atomic_json(target, {'generation': 2, 'message': 'complete'})
    status, code = 'committed', 0
except OSError as error:
    status, code = type(error).__name__, 20
except Exception as error:
    status, code = type(error).__name__, 21
print(json.dumps({'status': status, 'attempts': attempts, 'failures': failures,
                  'elapsed': time.monotonic() - started}), flush=True)
sys.exit(code)
"""


@unittest.skipUnless(os.name == "nt", "Actual Windows file-sharing semantics")
class AtomicWindowsTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / ".local/test-results/derived-atomic-windows"
        parent.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "fixture-status.json"
        self.blocked = self.root / "observed-sharing-denial.txt"
        self.original = b'{"generation":1,"message":"original"}\n'
        self.path.write_bytes(self.original)
        self.process = None
        self.handle = None
        self.addCleanup(self.cleanup_writer)
        self.addCleanup(self.close_reader)
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
            wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
            wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def reader(self, allow_delete=False):
        share = 0x1 | 0x2 | (0x4 if allow_delete else 0)
        self.handle = self.kernel.CreateFileW(str(self.path), 0x80000000,
            share, None, 3, 0x80, None)
        self.assertNotEqual(self.handle, ctypes.c_void_p(-1).value,
                            "Owned fixture reader must open successfully")

    def close_reader(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def cleanup_writer(self):
        if self.process is not None and self.process.poll() is None:
            # Only the exact child created by this test is ever terminated.
            self.process.kill()
            self.process.communicate(timeout=5)

    def writer(self):
        self.process = subprocess.Popen([sys.executable, "-c", WRITER,
            str(ROOT / "inference"), str(self.path), str(self.blocked)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW)

    def result(self):
        stdout, stderr = self.process.communicate(timeout=10)
        self.assertEqual(stderr, "", "Fixture writer should report through bounded JSON")
        return self.process.returncode, json.loads(stdout)

    def observe_real_denial(self):
        deadline = time.monotonic() + 3
        while not self.blocked.exists() and time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            time.sleep(.01)
        self.assertTrue(self.blocked.is_file(), "Actual reader must deny at least one replacement")

    def assert_clean(self):
        self.assertEqual(list(self.root.glob("fixture-status.json.*.tmp")), [],
                         "Owned temporary output must be removed after either outcome")

    def test_unlocked_existing_destination_can_be_replaced(self):
        self.writer()
        code, report = self.result()
        self.assertEqual(code, 0, report)
        self.assertEqual(report["failures"], [])
        self.assertEqual(json.loads(self.path.read_bytes()), {"generation": 2, "message": "complete"})
        self.assert_clean()

    def test_short_external_reader_lock_retries_then_commits(self):
        self.reader()
        self.writer()
        self.observe_real_denial()
        time.sleep(.3)
        self.assertIsNone(self.process.poll(), "Transient reader denial must not kill writer")
        self.assertEqual(self.path.read_bytes(), self.original)
        self.close_reader()
        code, report = self.result()
        self.assertEqual(code, 0, report)
        self.assertGreater(report["attempts"], 1)
        self.assertTrue(all(value in (5, 32, 33) for value in report["failures"]), report)
        self.assertEqual(json.loads(self.path.read_bytes()), {"generation": 2, "message": "complete"})
        self.assert_clean()

    def test_persistent_reader_lock_fails_bounded_without_partial_json(self):
        self.reader()
        self.writer()
        self.observe_real_denial()
        code, report = self.result()
        self.assertEqual(code, 20, report)
        self.assertGreater(report["attempts"], 1, "Persistent lock must exercise bounded retry")
        self.assertLess(report["elapsed"], 8, "A permanent reader cannot hang publication")
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assert_clean()

    def test_delete_sharing_reader_preserves_atomicity_then_replacement(self):
        self.reader(allow_delete=True)
        self.writer()
        # On this Windows installation MoveFileEx can still deny replacement
        # while a FILE_SHARE_DELETE reader is open. Do not assume instant
        # success from that flag: a brief reader must permit eventual commit.
        time.sleep(.3)
        self.close_reader()
        code, report = self.result()
        self.assertEqual(code, 0, report)
        self.assertTrue(all(value in (5, 32, 33) for value in report["failures"]), report)
        self.assertEqual(json.loads(self.path.read_bytes()), {"generation": 2, "message": "complete"})
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
